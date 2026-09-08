import type { FsEntry, SearchHit, SearchResponse } from "@fdrive/contracts";
import {
  baseName,
  DEFAULT_FUSION_K,
  filenameScore,
  fuseRankings,
  highlightRanges,
  isUnderPath,
  matchesSearchFilters,
  mimeFromExtension,
  parentPath,
  queryWords,
  type Scope,
  type SearchFilters,
  toPrefixTsQuery,
} from "@fdrive/core";
import type { ContentHit, FilenameHit, IndexedFile, IndexQueries, ScopePrefix } from "@fdrive/db";
import type {
  ReadAuthorizeResult,
  ReadAuthorizer,
  ReadAuthorizeTarget,
} from "../scoping/read-authorizer.ts";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import type { EmbedClient } from "./embeddings.js";
import { dateFromMtimeNs } from "./scopes.js";

/** How many rows each of the three underlying signals fans out to, matching filesai's `LIMIT 60`. */
const CONTENT_FANOUT_LIMIT = 60;
/** filesai's filename query caps at `LIMIT 25`. */
const FILENAME_FANOUT_LIMIT = 25;
/** At most this many derived folders are shown, per PLAN.md §7/§9. */
const MAX_FOLDERS = 5;
/** At most this many hits are shown in the "content matches" section. */
const MAX_CONTENT_HITS = 10;

export interface SearchServiceDeps {
  readonly indexQueries: IndexQueries;
  /** `null` when `FDRIVE_EMBED_URL` is not configured; semantic search never runs then. */
  readonly embedClient: EmbedClient | null;
  /** Whether `FDRIVE_THUMBS_DIR` is configured; when false, every hit reports `hasThumbnail: false`. */
  readonly thumbsEnabled: boolean;
  /**
   * The storage provider's recycle folder virtual path, when configured.
   * A result whose virtual path is this path or nested under it is treated
   * as unmapped (as if it were out of scope), so trashed files never
   * appear in search hits, folder grouping, or counts.
   */
  readonly trashPath: string | null;
  readonly clock: () => Date;
}

export interface SearchServiceInput {
  /**
   * The identity's verified index scopes, resolved once at the request
   * boundary (`ScopeResolver.verifiedIndexScopes`). Empty means index-backed
   * search is unavailable for this caller; this is never a caller-supplied
   * value.
   */
  readonly scopes: readonly Scope[];
  /**
   * A request-local live-read authorizer bound to the caller's own storage
   * (see `createReadAuthorizer`). Every candidate is checked against this
   * before it can appear in hits, snippets, thumbnail flags, or derived
   * folders.
   */
  readonly authorizer: ReadAuthorizer;
  readonly query: string;
  readonly filters: SearchFilters;
  readonly limit: number;
}

export interface SearchService {
  search(input: SearchServiceInput): Promise<SearchResponse>;
}

function elapsedMs(clock: () => Date, startedAt: Date): number {
  return Math.max(0, clock().getTime() - startedAt.getTime());
}

function emptyResponse(
  query: string,
  tookMs: number,
  opts: { degraded: boolean; unavailable: boolean; partial?: boolean },
): SearchResponse {
  return {
    query,
    sections: { folders: [], files: [], content: [] },
    degraded: opts.degraded,
    unavailable: opts.unavailable,
    ...(opts.partial === true ? { partial: true } : {}),
    tookMs,
  };
}

interface DeriveFoldersInput {
  readonly filenameRows: readonly FilenameHit[];
  readonly fileById: ReadonlyMap<number, IndexedFile>;
  /** Resolves an indexed file to its caller-visible virtual path, `null` when it is out of scope. */
  readonly virtualPathFor: (file: IndexedFile) => string | null;
  readonly authorizer: Pick<ReadAuthorizer, "authorize">;
  /** Called once per candidate folder whose live-read check itself failed (not merely "denied"). */
  readonly onAuthUnavailable: () => void;
}

/**
 * Derives the Folders section: the most recently modified parent directory
 * of each filename-matched file, live-read checked and capped at
 * `MAX_FOLDERS`. Never called while a type filter (`SearchFilters.exts`) is
 * active, since a type filter is a files-only filter and the candidate
 * folders below are not themselves filtered by extension (see the `search`
 * handler's call site).
 */
async function deriveFolders(input: DeriveFoldersInput): Promise<FsEntry[]> {
  const folderCandidates = new Map<string, Date>();
  for (const row of input.filenameRows) {
    const file = input.fileById.get(row.fileId);
    if (file === undefined) {
      continue;
    }
    const virtualPath = input.virtualPathFor(file);
    if (virtualPath === null) {
      continue;
    }
    const folder = parentPath(virtualPath);
    const modifiedAt = dateFromMtimeNs(file.mtimeNs);
    const existing = folderCandidates.get(folder);
    if (existing === undefined || modifiedAt.getTime() > existing.getTime()) {
      folderCandidates.set(folder, modifiedAt);
    }
  }

  const resolvedFolders = await Promise.all(
    Array.from(folderCandidates.entries()).map(
      async ([path, modifiedAt]): Promise<FsEntry | null> => {
        const authResult = await input.authorizer.authorize({ path, kind: "dir" });
        if (!authResult.allowed) {
          if (authResult.reason === "unavailable") {
            input.onAuthUnavailable();
          }
          return null;
        }
        return {
          name: baseName(path),
          path,
          kind: "dir",
          size: 0,
          modifiedAt: modifiedAt.toISOString(),
          ext: "",
          mime: null,
        };
      },
    ),
  );
  return resolvedFolders.filter((entry): entry is FsEntry => entry !== null).slice(0, MAX_FOLDERS);
}

/**
 * Builds the fdrive hybrid search service: the same ranking as filesai's
 * `mcp_server.search` (semantic top 60, full-text prefix `tsquery` top 60,
 * filename word hits plus trigram similarity top 25, reciprocal rank fusion
 * k=60), scoped to `input.scopes` (already verified by the caller), with
 * every candidate round-tripped (`roundTripVirtualPath`) and live-read
 * checked (`input.authorizer`) before it can contribute to hits, snippets,
 * thumbnail flags, or derived folders.
 */
export function createSearchService(deps: SearchServiceDeps): SearchService {
  return {
    async search(input: SearchServiceInput): Promise<SearchResponse> {
      const startedAt = deps.clock();
      const tookMs = () => elapsedMs(deps.clock, startedAt);

      if (input.scopes.length === 0) {
        return emptyResponse(input.query, tookMs(), { degraded: false, unavailable: true });
      }

      const rootIds = await deps.indexQueries.rootIdsByName();
      const rootNameById = new Map<number, string>();
      for (const [name, id] of Object.entries(rootIds)) {
        rootNameById.set(id, name);
      }

      const prefixes: ScopePrefix[] = [];
      for (const scope of input.scopes) {
        const rootId = rootIds[scope.rootName];
        if (rootId !== undefined) {
          prefixes.push({ rootId, fsPrefix: scope.fsPrefix });
        }
      }
      if (prefixes.length === 0) {
        return emptyResponse(input.query, tookMs(), { degraded: false, unavailable: true });
      }

      const authMemo = new Map<string, Promise<ReadAuthorizeResult>>();

      function authorizeMemo(target: ReadAuthorizeTarget): Promise<ReadAuthorizeResult> {
        const key = `${target.kind}:${target.path}`;
        let promise = authMemo.get(key);
        if (promise === undefined) {
          promise = input.authorizer.authorize(target);
          authMemo.set(key, promise);
        }
        return promise;
      }

      function virtualPathFor(file: IndexedFile): string | null {
        const rootName = rootNameById.get(file.rootId);
        if (rootName === undefined) {
          return null;
        }
        const virtualPath = roundTripVirtualPath(input.scopes, rootName, file.path);
        if (virtualPath === null) {
          return null;
        }
        if (
          deps.trashPath !== null &&
          (virtualPath === deps.trashPath || isUnderPath(deps.trashPath, virtualPath))
        ) {
          return null;
        }
        return virtualPath;
      }

      let authUnavailable = false;

      async function primeFanout<T extends { fileId: number }>(
        rowsPromise: Promise<T[]>,
      ): Promise<T[]> {
        const rows = await rowsPromise;
        if (rows.length === 0) {
          return rows;
        }
        try {
          const fanoutIdSet = new Set(rows.map((r) => r.fileId));
          const fileIds = Array.from(fanoutIdSet);
          const files = await deps.indexQueries.filesByIds(fileIds);
          const filePromises: Promise<unknown>[] = [];
          for (const file of files) {
            if (!fanoutIdSet.has(file.id)) {
              continue;
            }
            const virtualPath = virtualPathFor(file);
            if (virtualPath === null) {
              continue;
            }
            const modifiedAt = dateFromMtimeNs(file.mtimeNs);
            if (
              !matchesSearchFilters({ path: virtualPath, ext: file.ext, modifiedAt }, input.filters)
            ) {
              continue;
            }
            filePromises.push(authorizeMemo({ path: virtualPath, kind: "file" }));
          }
          await Promise.allSettled(filePromises);
        } catch {
          // If optional early metadata lookup fails, handle it and return unchanged rows so final lookup remains authoritative.
        }
        return rows;
      }

      const words = queryWords(input.query);
      const tsquery = toPrefixTsQuery(input.query);

      const fulltextPipeline = primeFanout(
        tsquery.length > 0
          ? deps.indexQueries.fulltext(prefixes, tsquery, CONTENT_FANOUT_LIMIT)
          : Promise.resolve<ContentHit[]>([]),
      );
      const filenamePromise =
        words.length > 0
          ? deps.indexQueries.filename(prefixes, words, input.query, FILENAME_FANOUT_LIMIT)
          : Promise.resolve<FilenameHit[]>([]);
      const embeddingPromise =
        deps.embedClient !== null
          ? deps.embedClient.embed(input.query)
          : Promise.resolve<readonly number[] | null>(null);
      const semanticPipeline = primeFanout(
        embeddingPromise.then((embedding) =>
          embedding !== null
            ? deps.indexQueries.semantic(prefixes, embedding, CONTENT_FANOUT_LIMIT)
            : Promise.resolve<ContentHit[]>([]),
        ),
      );

      const [embedding, semanticRows, fulltextRows, filenameRows] = await Promise.all([
        embeddingPromise,
        semanticPipeline,
        fulltextPipeline,
        filenamePromise,
      ]);
      const degraded = embedding === null;

      // The underlying queries are bounded (`LIMIT 60`/`LIMIT 25`); a row
      // count at the cap means there may be more matches this response never
      // saw, so the result is reported as partial rather than exhaustive.
      const fanoutCut =
        semanticRows.length >= CONTENT_FANOUT_LIMIT ||
        fulltextRows.length >= CONTENT_FANOUT_LIMIT ||
        filenameRows.length >= FILENAME_FANOUT_LIMIT;

      const textFused = fuseRankings<number>([
        semanticRows.map((row) => ({ id: row.fileId, snippet: row.snippet })),
        fulltextRows.map((row) => ({ id: row.fileId, snippet: row.snippet })),
      ]);

      const scoreById = new Map<number, number>();
      const snippetsById = new Map<number, readonly string[]>();
      for (const item of textFused) {
        scoreById.set(item.id, item.score);
        snippetsById.set(item.id, item.snippets);
      }
      filenameRows.forEach((row, index) => {
        const rank = index + 1;
        const contribution = filenameScore(row.hits, words.length, rank, DEFAULT_FUSION_K);
        scoreById.set(row.fileId, (scoreById.get(row.fileId) ?? 0) + contribution);
      });

      if (scoreById.size === 0) {
        return emptyResponse(input.query, tookMs(), {
          degraded,
          unavailable: false,
          partial: fanoutCut,
        });
      }

      const ranked = Array.from(scoreById.entries()).sort((a, b) => b[1] - a[1]);

      const neededIds = Array.from(
        new Set([...ranked.map(([id]) => id), ...filenameRows.map((row) => row.fileId)]),
      );
      const loadedFiles = await deps.indexQueries.filesByIds(neededIds);
      const fileById = new Map(loadedFiles.map((file) => [file.id, file]));

      // Start folder probes first so the request-local authorization
      // semaphore does not queue them behind every ranked file probe.
      const foldersPromise: Promise<FsEntry[]> =
        input.filters.exts === null
          ? deriveFolders({
              filenameRows,
              fileById,
              virtualPathFor,
              authorizer: { authorize: authorizeMemo },
              onAuthUnavailable: () => {
                authUnavailable = true;
              },
            })
          : Promise.resolve([]);

      // Every ranked candidate (bounded by the fanout above, not by
      // `input.limit`) is round-tripped and live-read checked; the limit is
      // applied only after inaccessible candidates are removed.
      const resolvedHitsPromise = Promise.all(
        ranked.map(async ([id, score]): Promise<SearchHit | null> => {
          const file = fileById.get(id);
          if (file === undefined) {
            return null;
          }
          const virtualPath = virtualPathFor(file);
          if (virtualPath === null) {
            return null;
          }
          const modifiedAt = dateFromMtimeNs(file.mtimeNs);
          if (
            !matchesSearchFilters({ path: virtualPath, ext: file.ext, modifiedAt }, input.filters)
          ) {
            return null;
          }
          const authResult = await authorizeMemo({ path: virtualPath, kind: "file" });
          if (!authResult.allowed) {
            if (authResult.reason === "unavailable") {
              authUnavailable = true;
            }
            return null;
          }
          const snippets = snippetsById.get(id) ?? [];
          const hasThumbnail =
            deps.thumbsEnabled && file.sha256 !== null
              ? (await deps.indexQueries.thumbnail(file.sha256, 256)) !== null
              : false;
          return {
            path: virtualPath,
            name: file.name,
            kind: "file",
            ext: file.ext,
            mime: mimeFromExtension(file.ext),
            size: file.size,
            modifiedAt: modifiedAt.toISOString(),
            score,
            snippets: snippets.map((text) => ({ text, ranges: highlightRanges(text, words) })),
            hasThumbnail,
          };
        }),
      );

      const [folders, resolvedHits] = await Promise.all([foldersPromise, resolvedHitsPromise]);

      const accessibleHits = resolvedHits.filter((hit): hit is SearchHit => hit !== null);
      const files = accessibleHits.slice(0, input.limit);
      const content = files.filter((hit) => hit.snippets.length > 0).slice(0, MAX_CONTENT_HITS);

      return {
        query: input.query,
        sections: { folders, files, content },
        degraded,
        unavailable: false,
        ...((fanoutCut || authUnavailable) && { partial: true }),
        tookMs: tookMs(),
      };
    },
  };
}
