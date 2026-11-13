import { eq, lt, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { roots, work } from "../schema/idx.js";

/** The `NOTIFY` channel the indexer listens on for new `idx.work` rows; the payload is the root's name. */
export const INDEX_WORK_CHANNEL = "idx_work";

/**
 * How long a hint stays useful. The indexer deletes rows as it applies them,
 * so only rows nothing drains grow old: no indexer running, or indexing off.
 * A scan covers whatever they described once indexing runs again.
 */
export const INDEX_WORK_RETENTION = "1 day";

/**
 * What an upload published, so the indexer can skip hashing a file that
 * still matches it: the digest, and the size, modification time, inode and
 * change time of the file it became. Only the last two are beyond a client's
 * control, so the indexer requires all four to match.
 */
export interface IndexWorkContent {
  readonly sha256: string;
  readonly size: number;
  readonly mtimeNs: bigint;
  /** The unsigned inode number, stored as the signed bigint with the same 64 bits. */
  readonly ino: bigint;
  readonly ctimeNs: bigint;
}

/**
 * One change under an index root, by root-relative path without a leading
 * slash (`alice/docs/a.pdf`, as `idx.files.path`). Without `targetPath` the
 * indexer looks at `path` again; with it, `path` moved to `targetPath`.
 */
export interface IndexWorkInput {
  readonly path: string;
  readonly targetPath?: string;
  readonly content?: IndexWorkContent;
}

/** Adds rows for one root and wakes the indexer. */
export type IndexWorkWriter = (root: string, items: readonly IndexWorkInput[]) => Promise<void>;

/**
 * Writes `idx.work` hints in one transaction: nothing when the root has no
 * row yet (the indexer creates it, and its first scan covers everything),
 * otherwise drop rows older than `INDEX_WORK_RETENTION`, add these and send
 * `NOTIFY idx_work`, which Postgres delivers on commit.
 */
export function createIndexWorkWriter(db: Db): IndexWorkWriter {
  return async (root, items) => {
    if (items.length === 0) return;
    await db.transaction(async (tx) => {
      const [found] = await tx.select({ id: roots.id }).from(roots).where(eq(roots.name, root));
      if (found === undefined) return;
      await tx
        .delete(work)
        .where(lt(work.createdAt, sql`now() - ${INDEX_WORK_RETENTION}::interval`));
      await tx.insert(work).values(
        items.map((item) => ({
          rootId: found.id,
          path: item.path,
          targetPath: item.targetPath ?? null,
          sha256: item.content?.sha256 ?? null,
          size: item.content?.size ?? null,
          mtimeNs: item.content?.mtimeNs ?? null,
          inode: item.content === undefined ? null : BigInt.asIntN(64, item.content.ino),
          ctimeNs: item.content?.ctimeNs ?? null,
        })),
      );
      await tx.execute(sql`select pg_notify(${INDEX_WORK_CHANNEL}, ${root})`);
    });
  };
}
