import type { FsEntry, SearchHit, SearchResponse } from "@fdrive/contracts";
import {
  baseName,
  DEFAULT_FUSION_K,
  filenameScore,
  fuseRankings,
  type HomeTemplate,
  highlightRanges,
  matchesSearchFilters,
  mimeFromExtension,
  parentPath,
  queryWords,
  type SearchFilters,
  toPrefixTsQuery,
  toVirtualPath,
} from "@fdrive/core";
import type { ContentHit, FilenameHit, IndexedFile, IndexQueries, ScopePrefix } from "@fdrive/db";
import type { EmbedClient } from "./embeddings.js";
import { dateFromMtimeNs, usableScopesFor } from "./scopes.js";

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
  readonly homeTemplate: HomeTemplate;
  /** Names of every configured index root (`FDRIVE_INDEX_ROOTS`); empty disables search entirely. */
  readonly indexRootNames: ReadonlySet<string>;
  /** Whether `FDRIVE_THUMBS_DIR` is configured; when false, every hit reports `hasThumbnail: false`. */
  readonly thumbsEnabled: boolean;
  readonly clock: () => Date;
}

export interface SearchServiceInput {
  readonly username: string;
  readonly query: string;
  readonly filters: SearchFilters;
  readonly limit: number;
}

export interface SearchStatus {
  readonly available: boolean;
  readonly semantic: boolean;
}

export interface SearchService {
  search(input: SearchServiceInput): Promise<SearchResponse>;
  status(): SearchStatus;
}

function elapsedMs(clock: () => Date, startedAt: Date): number {
  return Math.max(0, clock().getTime() - startedAt.getTime());
}

function emptyResponse(
  query: string,
  tookMs: number,
  opts: { degraded: boolean; unavailable: boolean },
): SearchResponse {
  return {
    query,
    sections: { folders: [], files: [], content: [] },
    degraded: opts.degraded,
    unavailable: opts.unavailable,
    tookMs,
  };
}

/**
 * Builds the fdrive hybrid search service: the same ranking as filesai's
 * `mcp_server.search` (semantic top 60, full-text prefix `tsquery` top 60,
 * filename word hits plus trigram similarity top 25, reciprocal rank fusion
 * k=60), scoped to the calling identity's index roots, with results mapped
 * back to virtual paths and grouped into folders/files/content sections.
 */
export function createSearchService(deps: SearchServiceDeps): SearchService {
  return {
    status(): SearchStatus {
      return {
        available: deps.indexRootNames.size > 0,
        semantic: deps.embedClient !== null,
      };
    },

    async search(input: SearchServiceInput): Promise<SearchResponse> {
      const startedAt = deps.clock();
      const tookMs = () => elapsedMs(deps.clock, startedAt);

      if (deps.indexRootNames.size === 0) {
        return emptyResponse(input.query, tookMs(), { degraded: false, unavailable: true });
      }

      const usableScopes = usableScopesFor(deps.homeTemplate, deps.indexRootNames, input.username);
      if (usableScopes.length === 0) {
        return emptyResponse(input.query, tookMs(), { degraded: false, unavailable: true });
      }

      const rootIds = await deps.indexQueries.rootIdsByName();
      const rootNameById = new Map<number, string>();
      for (const [name, id] of Object.entries(rootIds)) {
        rootNameById.set(id, name);
      }

      const prefixes: ScopePrefix[] = [];
      for (const scope of usableScopes) {
        const rootId = rootIds[scope.rootName];
        if (rootId !== undefined) {
          prefixes.push({ rootId, fsPrefix: scope.fsPrefix });
        }
      }
      if (prefixes.length === 0) {
        return emptyResponse(input.query, tookMs(), { degraded: false, unavailable: true });
      }

      const words = queryWords(input.query);
      const tsquery = toPrefixTsQuery(input.query);

      const embedding =
        deps.embedClient !== null ? await deps.embedClient.embed(input.query) : null;
      const degraded = embedding === null;

      const [semanticRows, fulltextRows, filenameRows] = await Promise.all([
        embedding !== null
          ? deps.indexQueries.semantic(prefixes, embedding, CONTENT_FANOUT_LIMIT)
          : Promise.resolve<ContentHit[]>([]),
        tsquery.length > 0
          ? deps.indexQueries.fulltext(prefixes, tsquery, CONTENT_FANOUT_LIMIT)
          : Promise.resolve<ContentHit[]>([]),
        words.length > 0
          ? deps.indexQueries.filename(prefixes, words, input.query, FILENAME_FANOUT_LIMIT)
          : Promise.resolve<FilenameHit[]>([]),
      ]);

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
        return emptyResponse(input.query, tookMs(), { degraded, unavailable: false });
      }

      const ranked = Array.from(scoreById.entries()).sort((a, b) => b[1] - a[1]);

      const neededIds = Array.from(
        new Set([...ranked.map(([id]) => id), ...filenameRows.map((row) => row.fileId)]),
      );
      const loadedFiles = await deps.indexQueries.filesByIds(neededIds);
      const fileById = new Map(loadedFiles.map((file) => [file.id, file]));

      function virtualPathFor(file: IndexedFile): string | null {
        const rootName = rootNameById.get(file.rootId);
        if (rootName === undefined) {
          return null;
        }
        return toVirtualPath(usableScopes, rootName, file.path);
      }

      const topRanked = ranked.slice(0, input.limit);
      const hitCandidates = await Promise.all(
        topRanked.map(async ([id, score]): Promise<SearchHit | null> => {
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

      const files = hitCandidates.filter((hit): hit is SearchHit => hit !== null);
      const content = files.filter((hit) => hit.snippets.length > 0).slice(0, MAX_CONTENT_HITS);

      const folderModifiedAt = new Map<string, Date>();
      for (const row of filenameRows) {
        const file = fileById.get(row.fileId);
        if (file === undefined) {
          continue;
        }
        const virtualPath = virtualPathFor(file);
        if (virtualPath === null) {
          continue;
        }
        const folder = parentPath(virtualPath);
        const modifiedAt = dateFromMtimeNs(file.mtimeNs);
        const existing = folderModifiedAt.get(folder);
        if (existing === undefined || modifiedAt.getTime() > existing.getTime()) {
          folderModifiedAt.set(folder, modifiedAt);
        }
      }
      const folders: FsEntry[] = Array.from(folderModifiedAt.entries())
        .slice(0, MAX_FOLDERS)
        .map(([path, modifiedAt]) => ({
          name: baseName(path),
          path,
          kind: "dir",
          size: 0,
          modifiedAt: modifiedAt.toISOString(),
          ext: "",
          mime: null,
        }));

      return {
        query: input.query,
        sections: { folders, files, content },
        degraded,
        unavailable: false,
        tookMs: tookMs(),
      };
    },
  };
}
