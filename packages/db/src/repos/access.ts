import { sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { deleteLocalGrantPrefix, moveLocalGrantPrefix } from "./drizzle.js";
import { createOfficeFileRepoWithRunner } from "./office-files.js";
import type { OfficeFileLocation } from "./office-files-state.js";
import { deleteSharePrefix, moveSharePrefix } from "./shares.js";

/**
 * What grants access to a path that moved or went, each in its owner's
 * files: public links, folders shared with people and Office files. A `to`
 * of `null` ends them (the item left its owner's files, or is gone).
 */
export interface AccessChange {
  readonly directory: boolean;
  /** Public links of the owner `identityId` (`ShareRepo.movePrefix`/`deletePrefix`). */
  readonly shares: { identityId: string; from: string; to: string | null } | null;
  /** Folders the local user `owner` shares with people (`LocalGrantRepo.movePrefix`/`deletePrefix`). */
  readonly grants: { owner: string; from: string; to: string | null } | null;
  /** Office files keep their ids wherever their files go (`OfficeFileRepo.movePrefix`/`deletePrefix`). */
  readonly office: { from: OfficeFileLocation; to: OfficeFileLocation | null } | null;
}

/**
 * A path a file operation holds until its transaction ends, in its owner's
 * files: `exclusive` for one it vacates, shared for every folder above a path
 * it touches and for one it creates.
 */
export interface PathLock {
  readonly identityId: string;
  readonly path: string;
  readonly exclusive: boolean;
}

export interface AccessRepo {
  /**
   * Runs `work` in one transaction that holds `locks` until it ends, and
   * applies each change `work` hands `follow` in that transaction: none of
   * them is kept unless `work` succeeds. A lock is taken in one order, so two
   * operations never wait for each other.
   */
  run<T>(
    locks: readonly PathLock[],
    work: (follow: (change: AccessChange) => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

function lockKey(lock: PathLock): string {
  return JSON.stringify(["file-path", lock.identityId, lock.path]);
}

/**
 * Each path once, exclusive when any of its locks is, in one order.
 */
function ordered(locks: readonly PathLock[]): { key: string; exclusive: boolean }[] {
  const byKey = new Map<string, boolean>();
  for (const lock of locks) {
    const key = lockKey(lock);
    byKey.set(key, (byKey.get(key) ?? false) || lock.exclusive);
  }
  return [...byKey]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, exclusive]) => ({ key, exclusive }));
}

/**
 * File operations' transactions, on a pool of their own: a transaction holds
 * its connection while the storage call inside it runs, and storage reads
 * the main pool meanwhile (users, grants, the files folder's facts).
 * Sharing one pool would deadlock once operations hold every connection.
 */
export function createAccessRepo(lockDb: Db, clock: () => Date = () => new Date()): AccessRepo {
  return {
    async run(locks, work) {
      return lockDb.transaction(async (tx) => {
        for (const { key, exclusive } of ordered(locks))
          await tx.execute(
            exclusive
              ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
              : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        const office = createOfficeFileRepoWithRunner(tx, (callback) => callback(tx));
        return work(async ({ directory, shares, grants, office: files }) => {
          if (shares !== null) {
            if (shares.to === null)
              await deleteSharePrefix(tx, shares.identityId, shares.from, directory);
            else await moveSharePrefix(tx, shares.identityId, shares.from, shares.to, directory);
          }
          if (grants !== null) {
            if (grants.to === null) await deleteLocalGrantPrefix(tx, grants.owner, grants.from);
            else await moveLocalGrantPrefix(tx, grants.owner, grants.from, grants.to);
          }
          if (files !== null) {
            if (files.to === null) await office.deletePrefix({ ...files.from, at: clock() });
            else await office.movePrefix({ from: files.from, to: files.to, at: clock() });
          }
        });
      });
    },
  };
}
