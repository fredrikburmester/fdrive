import { and, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { thumbnails } from "../schema/app.js";
import { chunks, files, roots } from "../schema/idx.js";
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

/** Aggregate counts over one scope, mirroring filesai's `index_stats`. */
export interface IndexStats {
  readonly filesTracked: number;
  readonly byTextStatus: readonly { status: string; files: number; bytes: number }[];
  readonly chunks: number;
  readonly chunksEmbedded: number;
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
  /** Every configured root's database id, keyed by name. */
  rootIdsByName(): Promise<Record<string, number>>;
  /** Aggregate file and chunk counts over a scope. */
  stats(scopePrefixes: readonly ScopePrefix[]): Promise<IndexStats>;
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
  };
}
