import type { FsEntry, SearchHit, SearchResponse } from "@fdrive/contracts";
import {
  baseName,
  DEFAULT_FUSION_K,
  filenameScore,
  fuseRankings,
  highlightRanges,
  matchesSearchFilters,
  mimeFromExtension,
  NAME_MATCH_BOOST,
  nameMatch,
  parentPath,
  queryWords,
  RECENCY_FLOOR,
  RECENCY_HALF_LIFE_DAYS,
  recencyWeight,
  type Scope,
  type SearchFilters,
  toPrefixTsQuery,
} from "@fdrive/core";
import type { ContentHit, FilenameHit, FolderHit, IndexedFile, IndexQueries } from "@fdrive/db";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import type { EmbedClient } from "./embeddings.js";
import type { NameIndexClient, NameIndexHit, NameIndexHits } from "./name-index.js";
import { dateFromMtimeNs, indexPrefixes, reservedExclusion } from "./scopes.js";

/** How many rows each of the three underlying signals fans out to, matching filesai's `LIMIT 60`. */
const CONTENT_FANOUT_LIMIT = 60;
/** filesai's filename query caps at `LIMIT 25`. */
const FILENAME_FANOUT_LIMIT = 25;
/** Folders whose name matched, read before ranking. */
const FOLDER_FANOUT_LIMIT = 50;
/** At most this many folders are shown. */
const MAX_FOLDERS = 5;
/** At most this many hits are shown in the "content matches" section. */
const MAX_CONTENT_HITS = 10;

export interface SearchServiceDeps {
  readonly features?: () => Promise<{
    textSearch: boolean;
    semanticSearch: boolean;
    thumbnails: boolean;
  }>;
  readonly indexQueries: IndexQueries;
  /** `null` when `FDRIVE_ML_URL` is not configured; semantic search never runs then. */
  readonly embedClient: EmbedClient | null;
  /**
   * The indexer's name index, which finds names typed with a typo or two;
   * `null` or absent when `FDRIVE_INDEXER_URL` is not configured. While it
   * cannot answer, search finds names only as typed.
   */
  readonly nameIndex?: NameIndexClient | null;
  /** Whether `FDRIVE_THUMBS_DIR` is configured; when false, every hit reports `hasThumbnail: false`. */
  readonly thumbsEnabled: boolean;
  readonly clock: () => Date;
}

export interface SearchServiceInput {
  /**
   * The identity's scopes, resolved once at the request boundary
   * (`ScopeResolver.scopesFor`). Empty means index-backed search is
   * unavailable for this caller; this is never a caller-supplied value.
   */
  readonly scopes: readonly Scope[];
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

interface RankFoldersInput {
  readonly rows: readonly FolderHit[];
  /** Folders the name index found, typos allowed; those `rows` already has are skipped. */
  readonly nameRows: readonly FolderHit[];
  readonly query: string;
  readonly filters: SearchFilters;
  readonly now: Date;
  /** Resolves an indexed path to its caller-visible virtual path, `null` when it is out of scope. */
  readonly virtualPathFor: (path: string) => string | null;
}

interface FolderCandidate {
  readonly path: string;
  readonly modifiedAt: Date;
  readonly score: number;
  /** The name matches only with a typo. */
  readonly typo: boolean;
}

/**
 * The Folders section: folders whose own name answers the query, empty ones
 * included, ranked like files by how the name matches (`nameMatch`) and then
 * by age (`recencyWeight`), and capped at `MAX_FOLDERS`.
 * A folder whose name matches only with a typo comes after every other.
 * The caller's own home (`/`) and the folder a folder filter starts at are
 * left out. Never called while a type filter (`SearchFilters.exts`) is
 * active: a type filter is a files-only filter.
 */
function rankFolders(input: RankFoldersInput): FsEntry[] {
  const candidates = new Map<string, FolderCandidate>();
  const consider = (row: FolderHit, fromNameIndex: boolean) => {
    const path = input.virtualPathFor(row.path);
    if (path === null || path === "/" || path === input.filters.folder || candidates.has(path)) {
      return;
    }
    const modifiedAt = dateFromMtimeNs(row.mtimeNs);
    if (!matchesSearchFilters({ path, ext: "", modifiedAt }, input.filters)) {
      return;
    }
    const match = nameMatch(input.query, { name: baseName(path), folder: parentPath(path) });
    // The name index reads words a little differently; only names fdrive itself would match count.
    if (fromNameIndex && match === "none") {
      return;
    }
    const score = (1 + NAME_MATCH_BOOST[match]) * recencyWeight(modifiedAt, input.now);
    candidates.set(path, { path, modifiedAt, score, typo: match === "typo" });
  };
  for (const row of input.rows) {
    consider(row, false);
  }
  for (const row of input.nameRows) {
    consider(row, true);
  }

  return Array.from(candidates.values())
    .sort(
      (a, b) =>
        Number(a.typo) - Number(b.typo) || b.score - a.score || a.path.localeCompare(b.path),
    )
    .slice(0, MAX_FOLDERS)
    .map(({ path, modifiedAt }) => ({
      name: baseName(path),
      path,
      kind: "dir",
      size: 0,
      modifiedAt: modifiedAt.toISOString(),
      ext: "",
      mime: null,
    }));
}

/** A name-index folder hit in the shape the folders query returns. */
function folderHit(hit: NameIndexHit): FolderHit {
  return { rootId: hit.rootId, path: hit.path, name: baseName(hit.path), mtimeNs: hit.mtimeNs };
}

/**
 * Builds the fdrive hybrid search service. Candidates come from three
 * bounded signals (semantic top 60, full-text prefix `tsquery` top 60,
 * filename word hits plus trigram similarity top 25) fused by reciprocal
 * rank (k=60), plus the files and folders the name index finds with a typo
 * or two (top 25 and 50). A file whose name answers the query (`nameMatch`)
 * is then lifted above every result found by content alone, a name that
 * matches only with a typo below every name spelled as typed, and every
 * score is weighted by the file's age (`recencyWeight`), so of two similar
 * matches the recently modified one comes first. Scoped to `input.scopes`
 * (the caller's own, resolved for this request), which is the permission:
 * every candidate is round-tripped (`roundTripVirtualPath`) before it can
 * contribute to hits, snippets, thumbnail flags, or folders, and the page
 * is cut to its limit before thumbnails are looked up, in one query. A file
 * gone from disk since it was indexed may still be listed until the next
 * index pass; opening it answers not found.
 */
export function createSearchService(deps: SearchServiceDeps): SearchService {
  return {
    async search(input: SearchServiceInput): Promise<SearchResponse> {
      const startedAt = deps.clock();
      const tookMs = () => elapsedMs(deps.clock, startedAt);
      const features = await deps.features?.();

      if (input.scopes.length === 0 || features?.textSearch === false) {
        return emptyResponse(input.query, tookMs(), { degraded: false, unavailable: true });
      }

      const prefixes = indexPrefixes(input.scopes);
      const exclude = reservedExclusion(input.scopes);

      function pathFor(path: string): string | null {
        return roundTripVirtualPath(input.scopes, path);
      }

      function virtualPathFor(file: IndexedFile): string | null {
        return pathFor(file.path);
      }

      const words = queryWords(input.query);
      const tsquery = toPrefixTsQuery(input.query);
      // The keyword queries weight by age themselves: their fanout is cut
      // before ranking here, and a common word would otherwise fill it with
      // old files before a recent one is ever seen.
      const recency = {
        now: startedAt,
        halfLifeDays: RECENCY_HALF_LIFE_DAYS,
        floor: RECENCY_FLOOR,
      };

      const fulltextPromise =
        tsquery.length > 0
          ? deps.indexQueries.fulltext(prefixes, tsquery, CONTENT_FANOUT_LIMIT, {
              recency,
              preferTsquery: toPrefixTsQuery(input.query, "all"),
              exclude,
            })
          : Promise.resolve<ContentHit[]>([]);
      const filenamePromise =
        words.length > 0
          ? deps.indexQueries.filename(prefixes, words, input.query, FILENAME_FANOUT_LIMIT, {
              recency,
              exclude,
            })
          : Promise.resolve<FilenameHit[]>([]);
      const folderRowsPromise =
        input.filters.exts === null && words.length > 0
          ? deps.indexQueries.folders(prefixes, words, input.query, FOLDER_FANOUT_LIMIT, {
              recency,
              exclude,
            })
          : Promise.resolve<FolderHit[]>([]);
      const namesPromise: Promise<NameIndexHits | null> =
        deps.nameIndex !== undefined && deps.nameIndex !== null && words.length > 0
          ? deps.nameIndex
              .search({
                query: input.query,
                scopes: prefixes,
                exclude,
                files: FILENAME_FANOUT_LIMIT,
                folders: input.filters.exts === null ? FOLDER_FANOUT_LIMIT : 0,
              })
              .catch(() => null)
          : Promise.resolve(null);
      const embeddingPromise =
        deps.embedClient !== null && features?.semanticSearch !== false
          ? deps.embedClient.embed(input.query)
          : Promise.resolve<readonly number[] | null>(null);
      const semanticPromise = embeddingPromise.then((embedding) =>
        embedding !== null
          ? deps.indexQueries.semantic(prefixes, embedding, CONTENT_FANOUT_LIMIT, { exclude })
          : Promise.resolve<ContentHit[]>([]),
      );

      const [embedding, semanticRows, fulltextRows, filenameRows, folderRows, names] =
        await Promise.all([
          embeddingPromise,
          semanticPromise,
          fulltextPromise,
          filenamePromise,
          folderRowsPromise,
          namesPromise,
        ]);
      const degraded = features?.semanticSearch !== false && embedding === null;
      const folders = rankFolders({
        rows: folderRows,
        nameRows: (names?.folders ?? []).map(folderHit),
        query: input.query,
        filters: input.filters,
        now: startedAt,
        virtualPathFor: pathFor,
      });

      // The underlying queries are bounded (`LIMIT 60`/`LIMIT 25`); a row
      // count at the cap means there may be more matches this response never
      // saw, so the result is reported as partial rather than exhaustive.
      const fanoutCut =
        semanticRows.length >= CONTENT_FANOUT_LIMIT ||
        fulltextRows.length >= CONTENT_FANOUT_LIMIT ||
        filenameRows.length >= FILENAME_FANOUT_LIMIT ||
        folderRows.length >= FOLDER_FANOUT_LIMIT ||
        (names?.files.length ?? 0) >= FILENAME_FANOUT_LIMIT ||
        (names?.folders.length ?? 0) >= FOLDER_FANOUT_LIMIT;

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
      // Files only the name index found, most a typo or two away, count as one
      // more filename list; `nameMatch` then ranks each by how its name
      // matches. One fdrive would not call a match at all is left out.
      const named = new Set(filenameRows.map((row) => row.fileId));
      (names?.files ?? [])
        .filter(
          (hit) =>
            !named.has(hit.id) &&
            nameMatch(input.query, { name: baseName(hit.path), folder: "" }) !== "none",
        )
        .forEach((hit, index) => {
          const contribution = filenameScore(
            words.length,
            words.length,
            index + 1,
            DEFAULT_FUSION_K,
          );
          scoreById.set(hit.id, (scoreById.get(hit.id) ?? 0) + contribution);
        });

      if (scoreById.size === 0) {
        return {
          ...emptyResponse(input.query, tookMs(), {
            degraded,
            unavailable: false,
            partial: fanoutCut,
          }),
          sections: { folders, files: [], content: [] },
        };
      }

      const loadedFiles = await deps.indexQueries.filesByIds(Array.from(scoreById.keys()));
      const fileById = new Map(loadedFiles.map((file) => [file.id, file]));

      // Every candidate the caller can see, best first. The fused score says
      // how well a file matched; its name and age decide what the caller most
      // likely meant.
      const visible = Array.from(scoreById.entries())
        .flatMap(([id, fused]) => {
          const file = fileById.get(id);
          const path = file === undefined ? null : virtualPathFor(file);
          if (file === undefined || path === null) return [];
          const modifiedAt = dateFromMtimeNs(file.mtimeNs);
          if (!matchesSearchFilters({ path, ext: file.ext, modifiedAt }, input.filters)) return [];
          const boost =
            NAME_MATCH_BOOST[nameMatch(input.query, { name: file.name, folder: parentPath(path) })];
          const score = (boost + fused) * recencyWeight(modifiedAt, startedAt);
          return [{ file, path, modifiedAt, score, snippets: snippetsById.get(id) ?? [] }];
        })
        .sort((a, b) => b.score - a.score);
      const shown = visible.slice(0, input.limit);
      // Taken from every visible hit, not from the page: name matches rank
      // first and can fill the limit, which must not hide what the content
      // signals found.
      const withContent = visible
        .filter((hit) => hit.snippets.length > 0)
        .slice(0, MAX_CONTENT_HITS);

      const keys = [...shown, ...withContent].flatMap((hit) =>
        hit.file.sha256 === null ? [] : [hit.file.sha256],
      );
      const thumbnails =
        deps.thumbsEnabled && features?.thumbnails !== false && keys.length > 0
          ? await deps.indexQueries.thumbnailKeys([...new Set(keys)], 256)
          : new Set<string>();
      const hitFor = (hit: (typeof visible)[number]): SearchHit => ({
        path: hit.path,
        name: hit.file.name,
        kind: "file",
        ext: hit.file.ext,
        mime: mimeFromExtension(hit.file.ext),
        size: hit.file.size,
        modifiedAt: hit.modifiedAt.toISOString(),
        score: hit.score,
        snippets: hit.snippets.map((text) => ({ text, ranges: highlightRanges(text, words) })),
        hasThumbnail: hit.file.sha256 !== null && thumbnails.has(hit.file.sha256),
      });

      return {
        query: input.query,
        sections: { folders, files: shown.map(hitFor), content: withContent.map(hitFor) },
        degraded,
        unavailable: false,
        ...(fanoutCut && { partial: true }),
        tookMs: tookMs(),
      };
    },
  };
}
