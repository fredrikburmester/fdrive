import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { changeCursors, changes, roots } from "../schema/idx.js";

/** The `NOTIFY` channel a write to `idx.changes` wakes; the payload is the root's name. */
export const CHANGES_CHANNEL = "idx_changes";

/**
 * How long rows stay in the journal. A month covers a Mac that was off for
 * a holiday and a consumer that was down for long; past it a consumer
 * resyncs from what is there now, which it must be able to do anyway.
 */
export const CHANGES_RETENTION = "30 days";

/**
 * Who wrote a row: the API and OCR for changes they made, the indexer's
 * watcher and scan for changes made outside fdrive that it applied.
 */
export type ChangeSource = "api" | "watcher" | "scan" | "ocr";

/**
 * What an upload published, so the indexer can skip hashing a file that
 * still matches it: the digest, and the size, modification time, inode and
 * change time of the file it became. Only the last two are beyond a client's
 * control, so the indexer requires all four to match.
 */
export interface ChangeContent {
  readonly sha256: string;
  readonly size: number;
  readonly mtimeNs: bigint;
  /** The unsigned inode number, stored as the signed bigint with the same 64 bits. */
  readonly ino: bigint;
  readonly ctimeNs: bigint;
}

/**
 * One change under an index root, by root-relative path without a leading
 * slash (`alice/docs/a.pdf`, as `idx.files.path`). Without `targetPath`:
 * look at `path` again (a file, a folder, or nothing any more). With it:
 * `path` moved to `targetPath`.
 */
export interface ChangeInput {
  readonly path: string;
  readonly targetPath?: string;
  readonly content?: ChangeContent;
}

/** A row of the journal; `position` orders them. */
export interface Change {
  readonly position: number;
  readonly path: string;
  readonly targetPath: string | null;
  readonly source: ChangeSource;
  /** Set when every column of an upload's hint is. */
  readonly content: ChangeContent | null;
  readonly createdAt: Date;
}

export interface ChangePage {
  /**
   * Rows after the position asked for were pruned: rebuild from what is
   * there now and continue from the newest position. It can be true when
   * nothing of this root was lost, never false when something was.
   */
  readonly gap: boolean;
  readonly changes: readonly Change[];
}

/** Appends one root's changes from one source; nothing for no items or a root the indexer has not created. */
export type ChangeWriter = (root: string, items: readonly ChangeInput[]) => Promise<void>;

export interface ChangeJournal {
  /**
   * Adds `items` under `root` in one transaction that holds the journal's
   * lock, so positions commit in order, and wakes `LISTEN idx_changes` with
   * the root's name on commit. Nothing when the root has no row yet: the
   * indexer creates it, and its first scan covers everything.
   */
  append(root: string, source: ChangeSource, items: readonly ChangeInput[]): Promise<void>;
  /**
   * Drops rows older than `CHANGES_RETENTION` as one prefix of positions,
   * keeping the newest row so the oldest one left always shows what is gone.
   * Returns the rows dropped.
   */
  prune(): Promise<number>;
  /** Up to `limit` rows of `root` after `after`, oldest first, and whether rows after it were pruned. */
  read(root: string, after: number, limit: number): Promise<ChangePage>;
  /** The newest position over every root; 0 before anything was written. A new consumer starts here. */
  end(): Promise<number>;
  /** Where `consumer` last saved its position for `root`, or `null`. */
  cursor(consumer: string, root: string): Promise<number | null>;
  /** Saves `consumer`'s position for `root`; nothing for an unknown root. */
  saveCursor(consumer: string, root: string, position: number): Promise<void>;
}

/**
 * Taken before inserting and held until commit, by every writer in every
 * language: positions are handed out and committed one transaction at a
 * time, so a reader that sees a position has seen every one below it.
 */
const JOURNAL_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('idx.changes', 0))`;

function contentOf(row: {
  sha256: string | null;
  size: number | null;
  mtimeNs: bigint | null;
  inode: bigint | null;
  ctimeNs: bigint | null;
}): ChangeContent | null {
  const { sha256, size, mtimeNs, inode, ctimeNs } = row;
  if (sha256 === null || size === null || mtimeNs === null || inode === null || ctimeNs === null)
    return null;
  return { sha256, size, mtimeNs, ino: BigInt.asUintN(64, inode), ctimeNs };
}

export function createChangeJournal(db: Db): ChangeJournal {
  return {
    async append(root, source, items) {
      if (items.length === 0) return;
      await db.transaction(async (tx) => {
        const [found] = await tx.select({ id: roots.id }).from(roots).where(eq(roots.name, root));
        if (found === undefined) return;
        await tx.execute(JOURNAL_LOCK);
        await tx.insert(changes).values(
          items.map((item) => ({
            rootId: found.id,
            path: item.path,
            targetPath: item.targetPath ?? null,
            source,
            sha256: item.content?.sha256 ?? null,
            size: item.content?.size ?? null,
            mtimeNs: item.content?.mtimeNs ?? null,
            inode: item.content === undefined ? null : BigInt.asIntN(64, item.content.ino),
            ctimeNs: item.content?.ctimeNs ?? null,
          })),
        );
        await tx.execute(sql`select pg_notify(${CHANGES_CHANNEL}, ${root})`);
      });
    },

    async prune() {
      const result = await db.execute(sql`
        delete from idx.changes
        where id <= (
            select id from idx.changes
            where created_at < now() - ${CHANGES_RETENTION}::interval
            order by created_at desc limit 1
          )
          and id < (select max(id) from idx.changes)
        returning id`);
      return result.rows.length;
    },

    async read(root, after, limit) {
      const [bounds] = await db
        .select({ oldest: sql<string | null>`min(${changes.id})` })
        .from(changes);
      const oldest = bounds?.oldest == null ? null : Number(bounds.oldest);
      const rows = await db
        .select({
          position: changes.id,
          path: changes.path,
          targetPath: changes.targetPath,
          source: changes.source,
          sha256: changes.sha256,
          size: changes.size,
          mtimeNs: changes.mtimeNs,
          inode: changes.inode,
          ctimeNs: changes.ctimeNs,
          createdAt: changes.createdAt,
        })
        .from(changes)
        .innerJoin(roots, eq(roots.id, changes.rootId))
        .where(and(eq(roots.name, root), gt(changes.id, after)))
        .orderBy(asc(changes.id))
        .limit(limit);
      return {
        gap: oldest !== null && after < oldest - 1,
        changes: rows.map((row) => ({
          position: row.position,
          path: row.path,
          targetPath: row.targetPath,
          source: row.source as ChangeSource,
          content: contentOf(row),
          createdAt: row.createdAt,
        })),
      };
    },

    async end() {
      const [row] = await db
        .select({ end: sql<string>`coalesce(max(${changes.id}), 0)` })
        .from(changes);
      return Number(row?.end ?? 0);
    },

    async cursor(consumer, root) {
      const [row] = await db
        .select({ position: changeCursors.position })
        .from(changeCursors)
        .innerJoin(roots, eq(roots.id, changeCursors.rootId))
        .where(and(eq(roots.name, root), eq(changeCursors.consumer, consumer)));
      return row?.position ?? null;
    },

    async saveCursor(consumer, root, position) {
      await db.execute(sql`
        insert into idx.change_cursors (root_id, consumer, position)
        select id, ${consumer}, ${position} from idx.roots where name = ${root}
        on conflict (root_id, consumer)
        do update set position = excluded.position, updated_at = now()`);
    },
  };
}

/**
 * A writer for one source that drops expired rows before it appends, so the
 * journal is pruned as long as anything writes to it.
 */
export function createChangeWriter(db: Db, source: ChangeSource): ChangeWriter {
  const journal = createChangeJournal(db);
  return async (root, items) => {
    if (items.length === 0) return;
    await journal.prune();
    await journal.append(root, source, items);
  };
}
