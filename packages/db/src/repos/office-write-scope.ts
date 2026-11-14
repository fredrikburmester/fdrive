import type { Db } from "../index.js";
import { createOfficeFileRepoWithRunner } from "./office-files.js";
import type { OfficeFileRepo } from "./office-files-state.js";
import { createOfficeScopeLifetime } from "./office-write-scope-state.js";
import type { WopiLockRepo } from "./wopi-lock-state.js";
import { createWopiLockRepoWithRunner } from "./wopi-locks.js";

export type OfficeQueryExecutor = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;
export type OfficeTransactionRunner = <T>(
  callback: (executor: OfficeQueryExecutor) => Promise<T>,
) => Promise<T>;
export interface OfficeWriteContext {
  readonly files: OfficeFileRepo;
  readonly locks: WopiLockRepo;
}
export type OfficeWriteScope = <T>(
  callback: (scope: OfficeWriteContext) => Promise<T>,
) => Promise<T>;

/**
 * One transaction for one Office write. It takes no lock of its own: the write
 * takes the locks of the documents and names it touches (`locks.withFileLock`)
 * and holds each until the transaction ends, so writes to one document
 * serialize and writes to different documents run side by side. Nested lock
 * and registry work runs on this transaction's connection, never a second one.
 *
 * Give it a pool of its own, shared only with the WOPI lock repository, so
 * that only that pool waits for these locks. A write holds its connection for
 * as long as its document's body takes to arrive, and checks edit admission
 * and records history on the main pool meanwhile: on a shared pool, writes
 * holding every connection would each wait forever for one more.
 *
 * The registry's lock is the exception: registry and desktop transactions on
 * the main pool wait for it. `files.ensure`, `files.movePrefix` and
 * `files.deletePrefix` take it until the transaction ends, so a write calls
 * them only as its last step, after any main pool work.
 */
export function createOfficeWriteScope(db: Db): OfficeWriteScope {
  return async (callback) =>
    db.transaction(async (tx) => {
      const lifetime = createOfficeScopeLifetime();
      try {
        const runTransaction: OfficeTransactionRunner = async (work) => {
          lifetime.assertActive();
          return work(tx);
        };
        return await callback({
          files: createOfficeFileRepoWithRunner(tx, runTransaction, lifetime.assertActive),
          locks: createWopiLockRepoWithRunner(runTransaction, lifetime.assertActive),
        });
      } finally {
        lifetime.close();
      }
    });
}
