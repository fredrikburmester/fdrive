import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import type { Db } from "../index.js";
import { imageEmbeddings, thumbnails } from "../schema/app.js";
import { chunks, files, moves, roots } from "../schema/idx.js";
import { formatVectorLiteral } from "../vector.js";

/**
 * One slice of the index a caller is allowed to see: every file in
 * `rootId` whose path is `fsPrefix` or nested under it. `fsPrefix` is
 * `@fdrive/core`'s normalized virtual-style scope prefix ("/" for the
 * whole root, "/alice" for a subtree), not the root-relative path the
 * indexer stores; `toScopeClauses` converts between the two.
 */
export interface ScopePrefix {
  readonly rootId: number;
  readonly fsPrefix: string;
}

/**
 * One `ScopePrefix` translated into the root-relative shape `idx.files.path`
 * actually uses: `relativePrefix` is `""` when the whole root matches
 * (`fsPrefix` was "/"), otherwise the prefix with its leading slash
 * stripped.
 */
export interface ScopeClause {
  readonly rootId: number;
  readonly relativePrefix: string;
}

/**
 * Converts `Scope`-shaped prefixes (leading-slash virtual style) into the
 * root-relative prefixes `idx.files.path` is stored as. Pure and
 * independent of any SQL builder, so it is unit tested without a database;
 * the SQL that consumes it is covered by the integration suite instead.
 */
export function toScopeClauses(prefixes: readonly ScopePrefix[]): ScopeClause[] {
  return prefixes.map((prefix) => ({
    rootId: prefix.rootId,
    relativePrefix: prefix.fsPrefix === "/" ? "" : prefix.fsPrefix.replace(/^\/+/, ""),
  }));
}

/**
 * Escapes `\`, `%`, and `_` in `value` so it can be embedded in a Postgres
 * `LIKE`/`ILIKE` pattern (with `ESCAPE '\'`) as a literal substring rather
 * than a wildcard expression.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Converts `mtimeNs` (nanoseconds since epoch, as the indexer stores it) to
 * a `Date`, truncating to millisecond precision. Mirrors `apps/api`'s
 * `dateFromMtimeNs`; duplicated here rather than imported so this package
 * has no dependency on the API app.
 */
function dateFromMtimeNs(mtimeNs: bigint): Date {
  return new Date(Number(mtimeNs / 1_000_000n));
}

/** A parsed `idx.files` row. */
export interface IndexedFile {
  readonly id: number;
  readonly rootId: number;
  readonly path: string;
  readonly name: string;
  readonly ext: string;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly sha256: string | null;
  readonly mime: string | null;
  readonly textStatus: string;
  readonly textChars: number;
  readonly error: string | null;
  readonly indexedAt: Date | null;
  readonly deletedAt: Date | null;
}

function toIndexedFile(row: typeof files.$inferSelect): IndexedFile {
  return {
    id: row.id,
    rootId: row.rootId,
    path: row.path,
    name: row.name,
    ext: row.ext,
    size: row.size,
    mtimeNs: row.mtimeNs,
    sha256: row.sha256,
    mime: row.mime,
    textStatus: row.textStatus,
    textChars: row.textChars,
    error: row.error,
    indexedAt: row.indexedAt,
    deletedAt: row.deletedAt,
  };
}

/** One hit from `semantic` or `fulltext`: a matching file plus a content excerpt. */
export interface ContentHit {
  readonly fileId: number;
  readonly snippet: string;
}

/** One hit from `filename`: a matching file, how many query words it contained, and its trigram similarity. */
export interface FilenameHit {
  readonly fileId: number;
  readonly hits: number;
  readonly similarity: number;
}

/** The total live bytes and file count under one directory, see `IndexQueries.subtreeSize`. */
export interface SubtreeSize {
  readonly bytes: number;
  readonly files: number;
}

/** Aggregate counts over one scope, mirroring filesai's `index_stats`. */
export interface IndexStats {
  readonly filesTracked: number;
  readonly byTextStatus: readonly { status: string; files: number; bytes: number }[];
  readonly chunks: number;
  readonly chunksEmbedded: number;
}

/** Chunk counts for exactly a caller-supplied set of file ids, see `IndexQueries.statsForFileIds`. */
export interface FileIdStats {
  readonly chunks: number;
  readonly chunksEmbedded: number;
}

/**
 * Hard upper bound on how many file ids `statsForFileIds` will ever embed
 * as SQL parameters in one query, defensively enforced inside the query
 * itself (not just by callers): a caller that authorized more than this
 * many files individually must call this more than once rather than grow
 * the parameter list unboundedly.
 */
export const MAX_STATS_FILE_ID_PARAMS = 2000;

/**
 * Metadata-only filters for `listFiles`, matching the MCP `find_files` tool
 * and the `folder_overview` aggregation.
 */
export interface FileFilter {
  readonly nameContains?: string;
  readonly ext?: string;
  readonly modifiedAfterNs?: bigint;
  readonly modifiedBeforeNs?: bigint;
  readonly minSize?: number;
}

/** Sort order for `listFiles`. */
export type FileOrder = "modified_desc" | "modified_asc" | "size_desc" | "path";

/** One move recorded in `idx.moves`, as read back by `recentMoves`. */
export interface MoveRecord {
  readonly at: Date;
  readonly rootId: number;
  readonly src: string | null;
  readonly dst: string | null;
  readonly actor: string | null;
}

/** One location a duplicate's bytes live at. */
export interface DuplicateLocation {
  readonly rootId: number;
  readonly path: string;
}

/** A group of byte-identical files (same sha256 and size), largest waste first. */
export interface DuplicateGroup {
  readonly sha256: string;
  readonly size: number;
  readonly count: number;
  readonly files: readonly DuplicateLocation[];
}

/** One result from `similar`: a file and its cosine similarity (1 - distance) to the query file. */
export interface SimilarFile {
  readonly fileId: number;
  readonly similarity: number;
}

/** One result from `searchImages`: a live file whose thumbnail's embedding matched, ranked by cosine similarity (1 - distance). */
export interface ImageSearchHit {
  readonly rootId: number;
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: Date;
  readonly score: number;
}

/**
 * Aggregate counts for `app.image_embeddings`, backing the System page.
 * `model` is the id embedding the most rows (rows from a stale model, left
 * behind by a model change, sort after it); `null` when the table is empty.
 */
export interface ImageEmbeddingStats {
  readonly total: number;
  readonly model: string | null;
}

/**
 * The hybrid-search and index-browsing queries, every one of which takes a
 * mandatory `scopePrefixes` (except `filesByIds`, `fileByPath`, and
 * `rootIdsByName`, which are looked up by exact identity and never need
 * scoping applied twice) so a caller can never see rows outside their
 * scope.
 */
export interface IndexQueries {
  /** Chunks closest to `embedding` by cosine distance, most similar first. */
  semantic(
    scopePrefixes: readonly ScopePrefix[],
    embedding: readonly number[],
    limit: number,
  ): Promise<ContentHit[]>;
  /** Chunks matching `tsquery` (a `to_tsquery('simple', ...)` expression), best rank first. */
  fulltext(
    scopePrefixes: readonly ScopePrefix[],
    tsquery: string,
    limit: number,
  ): Promise<ContentHit[]>;
  /** Files whose path contains any of `words`, or whose name is trigram-similar to `query`. */
  filename(
    scopePrefixes: readonly ScopePrefix[],
    words: readonly string[],
    query: string,
    limit: number,
  ): Promise<FilenameHit[]>;
  /** Loads files by id, in no particular order; missing ids are skipped. */
  filesByIds(ids: readonly number[]): Promise<IndexedFile[]>;
  /** The (non-deleted) file at exactly `path` in `rootId`, `null` when absent. */
  fileByPath(rootId: number, path: string): Promise<IndexedFile | null>;
  /**
   * Metadata-only listing over a scope: optional name/ext/date/size filters,
   * one of four sort orders, and the total match count (before `limit`).
   * Backs both the MCP `find_files` tool and `folder_overview`'s aggregation.
   */
  listFiles(
    scopePrefixes: readonly ScopePrefix[],
    filter: FileFilter,
    order: FileOrder,
    limit: number,
    offset?: number,
  ): Promise<{ total: number; files: IndexedFile[] }>;
  /** Every other (non-deleted) file in scope with the same sha256, excluding `excludeId`. */
  filesBySha256(
    scopePrefixes: readonly ScopePrefix[],
    sha256: string,
    excludeId: number,
  ): Promise<IndexedFile[]>;
  /**
   * The sha256 of the most recently soft-deleted row at exactly
   * `(rootId, path)`, or `null` when there is no deleted row there, or it
   * never had a hash. Used by the metadata sha256 relink fallback: a
   * `deleted` event whose path had tags or a favorite is checked against
   * this before being treated as a real delete.
   */
  deletedRowSha(rootId: number, path: string): Promise<string | null>;
  /** Every live (non-deleted) file in `rootId` with `sha256`, in no particular order. */
  liveRowsBySha(rootId: number, sha256: string): Promise<IndexedFile[]>;
  /** Every configured root's database id, keyed by name. */
  rootIdsByName(): Promise<Record<string, number>>;
  /**
   * Directories (root-relative, "" for the root itself) whose *direct* live
   * files include every name in `names`, across every root, most complete
   * matches first. Used to suggest where an unmapped SFTPGo virtual folder
   * physically lives; `names` must be non-empty and the result is capped at
   * `limit`. Subdirectories are not matched, only files.
   */
  directoriesWithFiles(
    names: readonly string[],
    limit: number,
  ): Promise<{ rootId: number; directory: string }[]>;
  /** Aggregate file and chunk counts over a scope. */
  stats(scopePrefixes: readonly ScopePrefix[]): Promise<IndexStats>;
  /**
   * The total live (non-deleted) bytes and file count under `rootId` at
   * exactly `relativePrefix` or nested under it (`""` matches the whole
   * root), intersected with `scopePrefixes` so a caller never sees bytes
   * from outside their own verified scope. `relativePrefix` is root-relative
   * (see `toScopeClauses`), not the leading-slash virtual style. Optional
   * `excludedRelativePrefixes` removes whole nested trees from the aggregate;
   * this lets virtual mount consumers exclude the physical trees shadowed by
   * more-specific mappings without reading their rows into application code.
   */
  subtreeSize(
    scopePrefixes: readonly ScopePrefix[],
    rootId: number,
    relativePrefix: string,
    excludedRelativePrefixes?: readonly string[],
  ): Promise<SubtreeSize>;
  /**
   * Chunk counts restricted to exactly `fileIds` (capped defensively at
   * `MAX_STATS_FILE_ID_PARAMS`), never a broader scope predicate. For a
   * caller (the MCP `index_stats` tool) that must report counts derived
   * only from files it individually authorized a live read for, rather than
   * every row `stats` would otherwise count regardless of authorization.
   */
  statsForFileIds(fileIds: readonly number[]): Promise<FileIdStats>;
  /** Groups of byte-identical files at least `minSize` bytes, largest waste first. */
  duplicates(
    scopePrefixes: readonly ScopePrefix[],
    minSize: number,
    limit: number,
  ): Promise<DuplicateGroup[]>;
  /** Files whose average chunk embedding is closest to `fileId`'s, excluding itself. */
  similar(
    fileId: number,
    scopePrefixes: readonly ScopePrefix[],
    limit: number,
  ): Promise<SimilarFile[]>;
  /** The most recently modified files in a scope. */
  recentFiles(scopePrefixes: readonly ScopePrefix[], limit: number): Promise<IndexedFile[]>;
  /** The cached thumbnail file for `(contentKey, size)`, `null` when not generated yet. */
  thumbnail(contentKey: string, size: number): Promise<{ storagePath: string } | null>;
  /**
   * Live files whose thumbnail embedding (joined `app.image_embeddings` on
   * `files.sha256 = image_embeddings.content_key`) is closest to `vector`
   * by cosine distance, restricted to rows written by `model` and to the
   * caller's scope. Rows from a different model never match, so a mid-flight
   * rebuild never mixes two embedding spaces into one ranking.
   */
  searchImages(
    scopePrefixes: readonly ScopePrefix[],
    vector: readonly number[],
    model: string,
    limit: number,
  ): Promise<ImageSearchHit[]>;
  /** Total embedded rows and the model that wrote the most of them, for the System page. */
  imageEmbeddingStats(): Promise<ImageEmbeddingStats>;
  /** Appends a row to `idx.moves`, the audit log the MCP `move_path` tool writes to and `recentMoves` reads back. */
  recordMove(input: { rootId: number; src: string; dst: string; actor: string }): Promise<void>;
  /** The most recent `idx.moves` rows for `actor`, restricted to roots present in `scopePrefixes`. */
  recentMoves(
    scopePrefixes: readonly ScopePrefix[],
    actor: string,
    limit: number,
  ): Promise<MoveRecord[]>;
}

/**
 * Builds the SQL predicate matching `idx.files.root_id`/`.path` against any
 * of `prefixes`. `false` (matches nothing) for an empty scope, so a caller
 * with no configured scope never sees rows by accident.
 */
function scopeCondition(prefixes: readonly ScopePrefix[]) {
  const clauses = toScopeClauses(prefixes);
  if (clauses.length === 0) {
    return sql`false`;
  }

  const parts = clauses.map((clause) => {
    if (clause.relativePrefix === "") {
      return sql`(${files.rootId} = ${clause.rootId})`;
    }
    const likePattern = `${escapeLikePattern(clause.relativePrefix)}/%`;
    return sql`(${files.rootId} = ${clause.rootId} AND (${files.path} = ${clause.relativePrefix} OR ${files.path} LIKE ${likePattern} ESCAPE '\\'))`;
  });

  // Wrapped in its own parens: this is handed to `and()` alongside other
  // conditions, which joins arguments with a plain " and " and only wraps
  // the *whole* result in parens, not each argument. Without this, an
  // unparenthesized top-level OR here would bind more loosely than the
  // ANDs around it and leak rows outside every scope.
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/** Restricts one `idx.moves` path to the caller's root-relative scope. */
function movePathScopeCondition(
  prefixes: readonly ScopePrefix[],
  pathColumn: typeof moves.src | typeof moves.dst,
) {
  const clauses = toScopeClauses(prefixes);
  if (clauses.length === 0) {
    return sql`false`;
  }

  const parts = clauses.map((clause) => {
    if (clause.relativePrefix === "") {
      return sql`(${moves.rootId} = ${clause.rootId})`;
    }
    const likePattern = `${escapeLikePattern(clause.relativePrefix)}/%`;
    return sql`(${moves.rootId} = ${clause.rootId} AND (${pathColumn} = ${clause.relativePrefix} OR ${pathColumn} LIKE ${likePattern} ESCAPE '\\'))`;
  });

  return sql`(${sql.join(parts, sql` OR `)})`;
}

const SNIPPET_LENGTH = 300;

/** Builds every `IndexQueries` method as Drizzle queries against `db`. */
export function createIndexQueries(db: Db): IndexQueries {
  return {
    async semantic(scopePrefixes, embedding, limit) {
      const vectorLiteral = formatVectorLiteral(embedding);
      const rows = await db
        .select({
          fileId: chunks.fileId,
          snippet: sql<string>`substring(${chunks.text} for ${SNIPPET_LENGTH})`.as("snippet"),
        })
        .from(chunks)
        .innerJoin(files, eq(files.id, chunks.fileId))
        .where(
          and(scopeCondition(scopePrefixes), isNull(files.deletedAt), isNotNull(chunks.embedding)),
        )
        .orderBy(sql`${chunks.embedding} <=> ${vectorLiteral}::vector`)
        .limit(limit);
      return rows;
    },

    async fulltext(scopePrefixes, tsquery, limit) {
      if (tsquery.length === 0) {
        return [];
      }
      const rank = sql<number>`ts_rank_cd(${chunks.tsv}, to_tsquery('simple', ${tsquery}))`;
      const rows = await db
        .select({
          fileId: chunks.fileId,
          snippet: sql<string>`substring(${chunks.text} for ${SNIPPET_LENGTH})`.as("snippet"),
        })
        .from(chunks)
        .innerJoin(files, eq(files.id, chunks.fileId))
        .where(
          and(
            scopeCondition(scopePrefixes),
            isNull(files.deletedAt),
            sql`${chunks.tsv} @@ to_tsquery('simple', ${tsquery})`,
          ),
        )
        .orderBy(desc(rank))
        .limit(limit);
      return rows;
    },

    async filename(scopePrefixes, words, query, limit) {
      if (words.length === 0) {
        return [];
      }
      const likePatterns = words.map((word) => `%${escapeLikePattern(word)}%`);
      const hitsExpr = sql.join(
        likePatterns.map(
          (pattern) =>
            sql`(CASE WHEN ${files.path} ILIKE ${pattern} ESCAPE '\\' THEN 1 ELSE 0 END)`,
        ),
        sql` + `,
      );
      // Parenthesized as a whole for the same reason as `scopeCondition`:
      // this OR expression is one argument to `and()` below, which does not
      // parenthesize individual arguments.
      const matchCondition = sql`(${sql.join(
        [
          ...likePatterns.map((pattern) => sql`${files.path} ILIKE ${pattern} ESCAPE '\\'`),
          sql`${files.name} % ${query}`,
        ],
        sql` OR `,
      )})`;

      const rows = await db
        .select({
          fileId: files.id,
          hits: sql<number>`(${hitsExpr})`.as("hits"),
          similarity: sql<number>`similarity(${files.name}, ${query})`.as("similarity"),
        })
        .from(files)
        .where(and(scopeCondition(scopePrefixes), isNull(files.deletedAt), matchCondition))
        .orderBy(sql`hits DESC`, sql`similarity DESC`)
        .limit(limit);

      return rows.map((row) => ({
        fileId: row.fileId,
        hits: Number(row.hits),
        similarity: Number(row.similarity),
      }));
    },

    async filesByIds(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await db
        .select()
        .from(files)
        .where(inArray(files.id, ids as number[]));
      return rows.map(toIndexedFile);
    },

    async fileByPath(rootId, path) {
      const [row] = await db
        .select()
        .from(files)
        .where(and(eq(files.rootId, rootId), eq(files.path, path), isNull(files.deletedAt)));
      return row ? toIndexedFile(row) : null;
    },

    async listFiles(scopePrefixes, filter, order, limit, offset = 0) {
      const conditions = [scopeCondition(scopePrefixes), isNull(files.deletedAt)];
      if (filter.nameContains !== undefined) {
        const pattern = `%${escapeLikePattern(filter.nameContains)}%`;
        conditions.push(sql`${files.name} ILIKE ${pattern} ESCAPE '\\'`);
      }
      if (filter.ext !== undefined) {
        conditions.push(eq(files.ext, filter.ext));
      }
      if (filter.modifiedAfterNs !== undefined) {
        conditions.push(sql`${files.mtimeNs} >= ${filter.modifiedAfterNs}`);
      }
      if (filter.modifiedBeforeNs !== undefined) {
        conditions.push(sql`${files.mtimeNs} <= ${filter.modifiedBeforeNs}`);
      }
      if (filter.minSize !== undefined) {
        conditions.push(sql`${files.size} >= ${filter.minSize}`);
      }
      const where = and(...conditions);

      const orderExpr =
        order === "modified_desc"
          ? desc(files.mtimeNs)
          : order === "modified_asc"
            ? files.mtimeNs
            : order === "size_desc"
              ? desc(files.size)
              : files.path;

      const [totalRow] = await db.select({ value: count() }).from(files).where(where);
      const rows = await db
        .select()
        .from(files)
        .where(where)
        .orderBy(orderExpr, files.id)
        .limit(limit)
        .offset(offset);

      return { total: Number(totalRow?.value ?? 0), files: rows.map(toIndexedFile) };
    },

    async filesBySha256(scopePrefixes, sha256, excludeId) {
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            scopeCondition(scopePrefixes),
            isNull(files.deletedAt),
            eq(files.sha256, sha256),
            ne(files.id, excludeId),
          ),
        )
        .orderBy(files.path);
      return rows.map(toIndexedFile);
    },

    async deletedRowSha(rootId, path) {
      const [row] = await db
        .select({ sha256: files.sha256 })
        .from(files)
        .where(and(eq(files.rootId, rootId), eq(files.path, path), isNotNull(files.deletedAt)))
        .orderBy(desc(files.deletedAt))
        .limit(1);
      return row?.sha256 ?? null;
    },

    async liveRowsBySha(rootId, sha256) {
      const rows = await db
        .select()
        .from(files)
        .where(and(eq(files.rootId, rootId), eq(files.sha256, sha256), isNull(files.deletedAt)));
      return rows.map(toIndexedFile);
    },

    async directoriesWithFiles(names, limit) {
      const unique = Array.from(new Set(names));
      if (unique.length === 0 || limit <= 0) return [];
      // The parent directory of a root-relative path: everything before the
      // last "/", or "" for a file directly under the root.
      const directory = sql<string>`case when position('/' in ${files.path}) = 0 then '' else regexp_replace(${files.path}, '/[^/]*$', '') end`;
      const rows = await db
        .select({ rootId: files.rootId, directory, matched: countDistinct(files.name) })
        .from(files)
        .where(and(inArray(files.name, unique), isNull(files.deletedAt)))
        .groupBy(files.rootId, directory)
        .having(sql`count(distinct ${files.name}) = ${unique.length}`)
        .orderBy(files.rootId, directory)
        .limit(limit);
      return rows.map((row) => ({ rootId: row.rootId, directory: row.directory }));
    },

    async rootIdsByName() {
      const rows = await db.select().from(roots);
      const map: Record<string, number> = {};
      for (const row of rows) {
        map[row.name] = row.id;
      }
      return map;
    },

    async stats(scopePrefixes) {
      const scope = scopeCondition(scopePrefixes);
      const byStatusRows = await db
        .select({
          status: files.textStatus,
          files: count(),
          bytes: sql<number>`coalesce(sum(${files.size}), 0)`,
        })
        .from(files)
        .where(and(scope, isNull(files.deletedAt)))
        .groupBy(files.textStatus);

      const filesTracked = byStatusRows.reduce((sum, row) => sum + Number(row.files), 0);

      const [chunkRow] = await db
        .select({
          chunks: count(),
          embedded: sql<number>`count(${chunks.embedding})`,
        })
        .from(chunks)
        .innerJoin(files, eq(files.id, chunks.fileId))
        .where(and(scope, isNull(files.deletedAt)));

      return {
        filesTracked,
        byTextStatus: byStatusRows.map((row) => ({
          status: row.status,
          files: Number(row.files),
          bytes: Number(row.bytes),
        })),
        chunks: Number(chunkRow?.chunks ?? 0),
        chunksEmbedded: Number(chunkRow?.embedded ?? 0),
      };
    },

    async subtreeSize(scopePrefixes, rootId, relativePrefix, excludedRelativePrefixes = []) {
      const pathCondition =
        relativePrefix === ""
          ? sql`true`
          : sql`(${files.path} = ${relativePrefix} OR ${files.path} LIKE ${`${escapeLikePattern(relativePrefix)}/%`} ESCAPE '\\')`;
      const exclusionConditions = excludedRelativePrefixes.map((prefix) =>
        prefix === ""
          ? sql`false`
          : sql`NOT (${files.path} = ${prefix} OR ${files.path} LIKE ${`${escapeLikePattern(prefix)}/%`} ESCAPE '\\')`,
      );

      const [row] = await db
        .select({
          bytes: sql<number>`coalesce(sum(${files.size}), 0)`,
          files: count(),
        })
        .from(files)
        .where(
          and(
            scopeCondition(scopePrefixes),
            isNull(files.deletedAt),
            eq(files.rootId, rootId),
            pathCondition,
            ...exclusionConditions,
          ),
        );

      return { bytes: Number(row?.bytes ?? 0), files: Number(row?.files ?? 0) };
    },

    async statsForFileIds(fileIds) {
      const capped = fileIds.slice(0, MAX_STATS_FILE_ID_PARAMS);
      if (capped.length === 0) {
        return { chunks: 0, chunksEmbedded: 0 };
      }
      const [row] = await db
        .select({
          chunks: count(),
          embedded: sql<number>`count(${chunks.embedding})`,
        })
        .from(chunks)
        .where(inArray(chunks.fileId, capped as number[]));
      return { chunks: Number(row?.chunks ?? 0), chunksEmbedded: Number(row?.embedded ?? 0) };
    },

    async duplicates(scopePrefixes, minSize, limit) {
      const rows = await db
        .select({
          sha256: files.sha256,
          size: files.size,
          count: count(),
          locations: sql<
            DuplicateLocation[]
          >`json_agg(json_build_object('rootId', ${files.rootId}, 'path', ${files.path}) ORDER BY ${files.path})`,
        })
        .from(files)
        .where(
          and(
            scopeCondition(scopePrefixes),
            isNull(files.deletedAt),
            isNotNull(files.sha256),
            sql`${files.size} >= ${minSize}`,
          ),
        )
        .groupBy(files.sha256, files.size)
        .having(sql`count(*) > 1`)
        .orderBy(desc(sql`${files.size} * (count(*) - 1)`))
        .limit(limit);

      return rows.map((row) => ({
        // `sha256 IS NOT NULL` is enforced above, so this is never null here.
        sha256: row.sha256 as string,
        size: Number(row.size),
        count: Number(row.count),
        files: row.locations,
      }));
    },

    async similar(fileId, scopePrefixes, limit) {
      const [avgRow] = await db
        .select({ avgEmbedding: sql<string | null>`avg(${chunks.embedding})::vector` })
        .from(chunks)
        .where(and(eq(chunks.fileId, fileId), isNotNull(chunks.embedding)));

      const avgEmbedding = avgRow?.avgEmbedding ?? null;
      if (avgEmbedding === null) {
        return [];
      }

      const distance = sql<number>`min(${chunks.embedding} <=> ${avgEmbedding}::vector)`;
      const rows = await db
        .select({ fileId: files.id, distance: distance.as("distance") })
        .from(chunks)
        .innerJoin(files, eq(files.id, chunks.fileId))
        .where(
          and(
            scopeCondition(scopePrefixes),
            isNull(files.deletedAt),
            ne(files.id, fileId),
            isNotNull(chunks.embedding),
          ),
        )
        .groupBy(files.id)
        .orderBy(sql`distance ASC`)
        .limit(limit);

      return rows.map((row) => ({ fileId: row.fileId, similarity: 1 - Number(row.distance) }));
    },

    async recentFiles(scopePrefixes, limit) {
      const rows = await db
        .select()
        .from(files)
        .where(and(scopeCondition(scopePrefixes), isNull(files.deletedAt)))
        .orderBy(desc(files.mtimeNs))
        .limit(limit);
      return rows.map(toIndexedFile);
    },

    async thumbnail(contentKey, size) {
      const [row] = await db
        .select({ storagePath: thumbnails.storagePath })
        .from(thumbnails)
        .where(and(eq(thumbnails.contentKey, contentKey), eq(thumbnails.size, size)));
      return row ?? null;
    },

    async searchImages(scopePrefixes, vector, model, limit) {
      const vectorLiteral = formatVectorLiteral(vector);
      const distance = sql<number>`${imageEmbeddings.embedding} <=> ${vectorLiteral}::vector`;
      const rows = await db
        .select({
          rootId: files.rootId,
          path: files.path,
          size: files.size,
          mtimeNs: files.mtimeNs,
          distance: distance.as("distance"),
        })
        .from(imageEmbeddings)
        .innerJoin(files, eq(files.sha256, imageEmbeddings.contentKey))
        .where(
          and(
            scopeCondition(scopePrefixes),
            isNull(files.deletedAt),
            eq(imageEmbeddings.model, model),
          ),
        )
        .orderBy(sql`distance ASC`)
        .limit(limit);

      return rows.map((row) => ({
        rootId: row.rootId,
        path: row.path,
        size: row.size,
        modifiedAt: dateFromMtimeNs(row.mtimeNs),
        score: 1 - Number(row.distance),
      }));
    },

    async imageEmbeddingStats() {
      const rows = await db
        .select({ model: imageEmbeddings.model, rows: count() })
        .from(imageEmbeddings)
        .groupBy(imageEmbeddings.model)
        .orderBy(desc(count()));

      const total = rows.reduce((sum, row) => sum + Number(row.rows), 0);
      return { total, model: rows[0]?.model ?? null };
    },

    async recordMove(input) {
      await db.insert(moves).values({
        rootId: input.rootId,
        src: input.src,
        dst: input.dst,
        actor: input.actor,
      });
    },

    async recentMoves(scopePrefixes, actor, limit) {
      if (scopePrefixes.length === 0) {
        return [];
      }
      const rows = await db
        .select()
        .from(moves)
        .where(
          and(
            movePathScopeCondition(scopePrefixes, moves.src),
            isNotNull(moves.src),
            movePathScopeCondition(scopePrefixes, moves.dst),
            isNotNull(moves.dst),
            eq(moves.actor, actor),
          ),
        )
        .orderBy(desc(moves.id))
        .limit(limit);
      return rows.map((row) => ({
        at: row.at ?? new Date(0),
        rootId: row.rootId,
        src: row.src,
        dst: row.dst,
        actor: row.actor,
      }));
    },
  };
}
