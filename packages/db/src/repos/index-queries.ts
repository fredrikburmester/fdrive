import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { imageEmbeddings, thumbnails } from "../schema/app.js";
import { chunks, files, folders, moves, roots } from "../schema/idx.js";
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

/** One file to look up by its root's name and its root-relative path. */
export interface IndexRef {
  readonly rootName: string;
  /** Root-relative, like `idx.files.path`. */
  readonly path: string;
}

/**
 * A live file's digest and what stands behind it, see
 * `IndexQueries.contentAt`. `inode` and `ctimeNs` are the stamp of the
 * indexer's own read that produced `sha256`, or null when no such read
 * stands behind it (see `idx.files.inode`).
 */
export interface IndexedContent extends IndexRef {
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly sha256: string | null;
  readonly inode: bigint | null;
  readonly ctimeNs: bigint | null;
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

/**
 * How a query weights a file by its age: `1` for a file modified at `now`,
 * falling by half of what is left above `floor` every `halfLifeDays`.
 */
export interface RecencyDecay {
  readonly now: Date;
  readonly halfLifeDays: number;
  readonly floor: number;
}

/**
 * What a read over a scope leaves out: rows at or under one of `prefixes`
 * (shaped like the scope), and rows with a folder named one of `names`, in
 * any case, anywhere in their path. They are dropped before the limit and
 * every count, so they never take a place or a total a row the caller can
 * use would have had. The API leaves fdrive's own folders out here
 * (`isReservedPath` in `@fdrive/core`).
 */
export interface IndexExclusion {
  readonly prefixes: readonly ScopePrefix[];
  readonly names: readonly string[];
}

/** Options every scoped read that can leave rows out takes. */
export interface ScopedReadOptions {
  readonly exclude?: IndexExclusion;
}

/** Options for `IndexQueries.fulltext`. */
export interface FulltextOptions extends ScopedReadOptions {
  /** Weights each chunk's rank by its file's age; by rank alone when absent. */
  readonly recency?: RecencyDecay;
  /** A stricter `to_tsquery('simple', ...)` expression; chunks matching it sort ahead of the rest. */
  readonly preferTsquery?: string;
}

/** One folder whose own name matched `IndexQueries.folders`. */
export interface FolderHit {
  readonly rootId: number;
  /** Root-relative, like `idx.files.path`. */
  readonly path: string;
  readonly name: string;
  readonly mtimeNs: bigint;
}

/** Options for `IndexQueries.folders`. */
export interface FolderOptions extends ScopedReadOptions {
  /** Weights each name's similarity by the folder's age; by similarity alone when absent. */
  readonly recency?: RecencyDecay;
}

/** Options for `IndexQueries.filename`. */
export interface FilenameOptions extends ScopedReadOptions {
  /** Weights each name's similarity by its file's age; by similarity alone when absent. */
  readonly recency?: RecencyDecay;
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
export interface FileFilter extends ScopedReadOptions {
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
    options?: ScopedReadOptions,
  ): Promise<ContentHit[]>;
  /** Chunks matching `tsquery` (a `to_tsquery('simple', ...)` expression), best rank first. */
  fulltext(
    scopePrefixes: readonly ScopePrefix[],
    tsquery: string,
    limit: number,
    options?: FulltextOptions,
  ): Promise<ContentHit[]>;
  /**
   * Files whose path contains any of `words`, or whose name is trigram-similar
   * to `query`: most words in the name first, then most words in the path,
   * then most similar name. An accent matches whether the stored name holds
   * it as one character or as a letter plus a combining mark.
   */
  filename(
    scopePrefixes: readonly ScopePrefix[],
    words: readonly string[],
    query: string,
    limit: number,
    options?: FilenameOptions,
  ): Promise<FilenameHit[]>;
  /**
   * Folders, empty ones included, whose own name contains every one of
   * `words`, ignoring case and how accents are encoded: most similar to
   * `query` first, weighted by age when `recency` is given.
   */
  folders(
    scopePrefixes: readonly ScopePrefix[],
    words: readonly string[],
    query: string,
    limit: number,
    options?: FolderOptions,
  ): Promise<FolderHit[]>;
  /** Loads files by id, in no particular order; missing ids are skipped. */
  filesByIds(ids: readonly number[]): Promise<IndexedFile[]>;
  /** The (non-deleted) file at exactly `path` in `rootId`, `null` when absent. */
  fileByPath(rootId: number, path: string): Promise<IndexedFile | null>;
  /**
   * The live rows at exactly these `(rootName, path)` pairs, in one query
   * and no particular order; a pair without a live row is left out. Like
   * `fileByPath` it applies no scope of its own: callers map each path
   * through the caller's verified scopes first.
   */
  contentAt(refs: readonly IndexRef[]): Promise<IndexedContent[]>;
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
    options?: ScopedReadOptions,
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
  /**
   * The start of one file's extracted text, its chunks joined in order and
   * cut at `maxChars`; empty when it has none. Looked up by exact id, so the
   * caller must already have mapped and read-authorized the file.
   */
  fileTextPrefix(fileId: number, maxChars: number): Promise<string>;
  /** Groups of byte-identical files at least `minSize` bytes, largest waste first. */
  duplicates(
    scopePrefixes: readonly ScopePrefix[],
    minSize: number,
    limit: number,
    options?: ScopedReadOptions,
  ): Promise<DuplicateGroup[]>;
  /** Files whose average chunk embedding is closest to `fileId`'s, excluding itself. */
  similar(
    fileId: number,
    scopePrefixes: readonly ScopePrefix[],
    limit: number,
    options?: ScopedReadOptions,
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
    options?: ScopedReadOptions,
  ): Promise<ImageSearchHit[]>;
  /** Total embedded rows and the model that wrote the most of them, for the System page. */
  imageEmbeddingStats(): Promise<ImageEmbeddingStats>;
  /** Appends a row to `idx.moves`, the audit log the MCP `move_path` tool writes to and `recentMoves` reads back. */
  recordMove(input: { rootId: number; src: string; dst: string; actor: string }): Promise<void>;
  /**
   * The most recent `idx.moves` rows for `actor` whose both ends lie in
   * `scopePrefixes`; with `exclude`, a move either end of which it leaves
   * out is left out.
   */
  recentMoves(
    scopePrefixes: readonly ScopePrefix[],
    actor: string,
    limit: number,
    options?: ScopedReadOptions,
  ): Promise<MoveRecord[]>;
}

/**
 * Builds the SQL predicate matching `idx.files.root_id`/`.path` against any
 * of `prefixes`. `false` (matches nothing) for an empty scope, so a caller
 * with no configured scope never sees rows by accident.
 */
function scopeCondition(prefixes: readonly ScopePrefix[], columns: PathColumns = FILE_COLUMNS) {
  const clauses = toScopeClauses(prefixes);
  if (clauses.length === 0) {
    return sql`false`;
  }

  const parts = clauses.map((clause) => underClause(clause, columns));

  // Wrapped in its own parens: this is handed to `and()` alongside other
  // conditions, which joins arguments with a plain " and " and only wraps
  // the *whole* result in parens, not each argument. Without this, an
  // unparenthesized top-level OR here would bind more loosely than the
  // ANDs around it and leak rows outside every scope.
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/** The root and path columns of a table whose rows `ScopePrefix`es select. */
interface PathColumns {
  readonly rootId: typeof files.rootId | typeof folders.rootId | typeof moves.rootId;
  readonly path: typeof files.path | typeof folders.path | typeof moves.src | typeof moves.dst;
}

const FILE_COLUMNS: PathColumns = { rootId: files.rootId, path: files.path };
const FOLDER_COLUMNS: PathColumns = { rootId: folders.rootId, path: folders.path };

/** Matches the rows at or under one root-relative scope clause, `idx.files` by default. */
function underClause(clause: ScopeClause, columns: PathColumns = FILE_COLUMNS) {
  if (clause.relativePrefix === "") {
    return sql`(${columns.rootId} = ${clause.rootId})`;
  }
  const likePattern = `${escapeLikePattern(clause.relativePrefix)}/%`;
  return sql`(${columns.rootId} = ${clause.rootId} AND (${columns.path} = ${clause.relativePrefix} OR ${columns.path} LIKE ${likePattern} ESCAPE '\\'))`;
}

/**
 * Leaves out what `exclude` names (see `IndexExclusion`); `undefined`, which
 * `and()` skips, when it names nothing. A name is matched as a whole segment
 * of the path, its own last one included.
 */
function exclusionCondition(exclude: IndexExclusion | undefined, columns = FILE_COLUMNS) {
  const parts = [
    ...toScopeClauses(exclude?.prefixes ?? []).map(
      (clause) => sql`NOT ${underClause(clause, columns)}`,
    ),
    ...(exclude?.names ?? []).map(
      (name) =>
        sql`('/' || ${columns.path} || '/') NOT ILIKE ${`%/${escapeLikePattern(name)}/%`} ESCAPE '\\'`,
    ),
  ];
  return parts.length === 0 ? undefined : and(...parts);
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

const NS_PER_DAY = 86_400_000_000_000;

/** `RecencyDecay` as a SQL factor over a `mtime_ns` column; `1` when no decay is asked for. */
function recencyFactor(
  recency: RecencyDecay | undefined,
  mtimeNs: typeof files.mtimeNs | typeof folders.mtimeNs = files.mtimeNs,
) {
  if (recency === undefined) {
    return sql`1`;
  }
  const nowNs = BigInt(recency.now.getTime()) * 1_000_000n;
  const ageDays = sql`greatest(${nowNs}::bigint - ${mtimeNs}, 0)::double precision / ${NS_PER_DAY}::double precision`;
  return sql`(${recency.floor}::double precision + ${1 - recency.floor}::double precision * power(0.5::double precision, ${ageDays} / ${recency.halfLifeDays}::double precision))`;
}

/**
 * `text` as typed and as macOS stores it: an accented letter is one
 * character when composed and a letter plus a combining mark when not, and
 * the two never compare equal in SQL. One entry when they are the same.
 */
function accentForms(text: string): string[] {
  return Array.from(new Set([text.normalize("NFC"), text.normalize("NFD")]));
}

const SNIPPET_LENGTH = 300;

/** Chunks `fileTextPrefix` reads at most; a prefix is meant to be short. */
const FILE_TEXT_PREFIX_CHUNKS = 8;

/** Builds every `IndexQueries` method as Drizzle queries against `db`. */
export function createIndexQueries(db: Db): IndexQueries {
  return {
    async semantic(scopePrefixes, embedding, limit, options = {}) {
      const vectorLiteral = formatVectorLiteral(embedding);
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
            exclusionCondition(options.exclude),
            isNull(files.deletedAt),
            isNotNull(chunks.embedding),
          ),
        )
        .orderBy(sql`${chunks.embedding} <=> ${vectorLiteral}::vector`)
        .limit(limit);
      return rows;
    },

    async fulltext(scopePrefixes, tsquery, limit, options = {}) {
      if (tsquery.length === 0) {
        return [];
      }
      const rank = sql<number>`ts_rank_cd(${chunks.tsv}, to_tsquery('simple', ${tsquery})) * ${recencyFactor(options.recency)}`;
      const preferred =
        options.preferTsquery === undefined || options.preferTsquery.length === 0
          ? []
          : [desc(sql`(${chunks.tsv} @@ to_tsquery('simple', ${options.preferTsquery}))`)];
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
            exclusionCondition(options.exclude),
            isNull(files.deletedAt),
            sql`${chunks.tsv} @@ to_tsquery('simple', ${tsquery})`,
          ),
        )
        .orderBy(...preferred, desc(rank))
        .limit(limit);
      return rows;
    },

    async filename(scopePrefixes, words, query, limit, options = {}) {
      if (words.length === 0) {
        return [];
      }
      const wordPatterns = words.map((word) =>
        accentForms(word).map((form) => `%${escapeLikePattern(form)}%`),
      );
      const contains = (column: typeof files.path | typeof files.name, patterns: string[]) =>
        sql`(${sql.join(
          patterns.map((pattern) => sql`${column} ILIKE ${pattern} ESCAPE '\\'`),
          sql` OR `,
        )})`;
      const hitsIn = (column: typeof files.path | typeof files.name) =>
        sql<number>`(${sql.join(
          wordPatterns.map(
            (patterns) => sql`(CASE WHEN ${contains(column, patterns)} THEN 1 ELSE 0 END)`,
          ),
          sql` + `,
        )})`;
      const queryForms = accentForms(query);
      const similarity = sql<number>`greatest(${sql.join(
        queryForms.map((form) => sql`similarity(${files.name}, ${form})`),
        sql`, `,
      )})`;
      // Parenthesized as a whole for the same reason as `scopeCondition`:
      // this OR expression is one argument to `and()` below, which does not
      // parenthesize individual arguments.
      const matchCondition = sql`(${sql.join(
        [
          ...wordPatterns.map((patterns) => contains(files.path, patterns)),
          ...queryForms.map((form) => sql`${files.name} % ${form}`),
        ],
        sql` OR `,
      )})`;

      const rows = await db
        .select({
          fileId: files.id,
          hits: hitsIn(files.path).as("hits"),
          similarity: similarity.as("similarity"),
        })
        .from(files)
        .where(
          and(
            scopeCondition(scopePrefixes),
            exclusionCondition(options.exclude),
            isNull(files.deletedAt),
            matchCondition,
          ),
        )
        // A word in the name says more than the same word in a folder above
        // it, which every file in that folder shares.
        .orderBy(
          desc(hitsIn(files.name)),
          sql`hits DESC`,
          desc(sql`${similarity} * ${recencyFactor(options.recency)}`),
        )
        .limit(limit);

      return rows.map((row) => ({
        fileId: row.fileId,
        hits: Number(row.hits),
        similarity: Number(row.similarity),
      }));
    },

    async folders(scopePrefixes, words, query, limit, options = {}) {
      if (words.length === 0) {
        return [];
      }
      const nameHas = (word: string) =>
        sql`(${sql.join(
          accentForms(word).map(
            (form) => sql`${folders.name} ILIKE ${`%${escapeLikePattern(form)}%`} ESCAPE '\\'`,
          ),
          sql` OR `,
        )})`;
      const similarity = sql`greatest(${sql.join(
        accentForms(query).map((form) => sql`similarity(${folders.name}, ${form})`),
        sql`, `,
      )})`;
      const rows = await db
        .select({
          rootId: folders.rootId,
          path: folders.path,
          name: folders.name,
          mtimeNs: folders.mtimeNs,
        })
        .from(folders)
        .where(
          and(
            scopeCondition(scopePrefixes, FOLDER_COLUMNS),
            exclusionCondition(options.exclude, FOLDER_COLUMNS),
            ...words.map(nameHas),
          ),
        )
        .orderBy(
          desc(sql`${similarity} * ${recencyFactor(options.recency, folders.mtimeNs)}`),
          asc(folders.path),
        )
        .limit(limit);
      return rows;
    },

    async filesByIds(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await db
        .select()
        .from(files)
        .where(and(inArray(files.id, ids as number[]), isNull(files.deletedAt)));
      return rows.map(toIndexedFile);
    },

    async fileByPath(rootId, path) {
      const [row] = await db
        .select()
        .from(files)
        .where(and(eq(files.rootId, rootId), eq(files.path, path), isNull(files.deletedAt)));
      return row ? toIndexedFile(row) : null;
    },

    async contentAt(refs) {
      if (refs.length === 0) {
        return [];
      }
      const names = [...new Set(refs.map((ref) => ref.rootName))];
      const paths = [...new Set(refs.map((ref) => ref.path))];
      const rows = await db
        .select({
          rootName: roots.name,
          path: files.path,
          size: files.size,
          mtimeNs: files.mtimeNs,
          sha256: files.sha256,
          inode: files.inode,
          ctimeNs: files.ctimeNs,
        })
        .from(files)
        .innerJoin(roots, eq(roots.id, files.rootId))
        .where(
          and(inArray(roots.name, names), inArray(files.path, paths), isNull(files.deletedAt)),
        );
      // Names and paths are matched separately above; only the exact pairs asked for count.
      const wanted = new Set(refs.map((ref) => JSON.stringify([ref.rootName, ref.path])));
      return rows.filter((row) => wanted.has(JSON.stringify([row.rootName, row.path])));
    },

    async listFiles(scopePrefixes, filter, order, limit, offset = 0) {
      const conditions = [
        scopeCondition(scopePrefixes),
        exclusionCondition(filter.exclude),
        isNull(files.deletedAt),
      ];
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

    async filesBySha256(scopePrefixes, sha256, excludeId, options = {}) {
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            scopeCondition(scopePrefixes),
            exclusionCondition(options.exclude),
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

    async fileTextPrefix(fileId, maxChars) {
      if (maxChars <= 0) return "";
      const rows = await db
        .select({ text: sql<string>`substring(${chunks.text} for ${maxChars})` })
        .from(chunks)
        .where(eq(chunks.fileId, fileId))
        .orderBy(asc(chunks.idx))
        .limit(FILE_TEXT_PREFIX_CHUNKS);
      return rows
        .map((row) => row.text)
        .join("\n")
        .slice(0, maxChars);
    },

    async duplicates(scopePrefixes, minSize, limit, options = {}) {
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
            exclusionCondition(options.exclude),
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

    async similar(fileId, scopePrefixes, limit, options = {}) {
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
            exclusionCondition(options.exclude),
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

    async searchImages(scopePrefixes, vector, model, limit, options = {}) {
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
            exclusionCondition(options.exclude),
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

    async recentMoves(scopePrefixes, actor, limit, options = {}) {
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
            exclusionCondition(options.exclude, { rootId: moves.rootId, path: moves.src }),
            exclusionCondition(options.exclude, { rootId: moves.rootId, path: moves.dst }),
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
