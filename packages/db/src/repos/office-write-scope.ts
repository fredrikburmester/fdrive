import { sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { createOfficeFileRepoWithRunner } from "./office-files.js";
import { type OfficeFileRepo, validateOfficeId } from "./office-files-state.js";
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
  providerId: string,
  callback: (scope: OfficeWriteContext) => Promise<T>,
) => Promise<T>;

/** One connection owns the provider gate and every nested registry/file lock. */
export function createOfficeWriteScope(db: Db): OfficeWriteScope {
  return async (providerId, callback) => {
    validateOfficeId(providerId);
    return db.transaction(async (tx) => {
      const lifetime = createOfficeScopeLifetime();
      try {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`office-write:${providerId}`}, 0))`,
        );
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
  };
}
