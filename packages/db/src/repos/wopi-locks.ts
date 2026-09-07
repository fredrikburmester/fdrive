import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { wopiLocks } from "../schema/app.js";
import type { OfficeTransactionRunner } from "./office-write-scope.js";
import {
  transitionWopiLock,
  validateWopiFileId,
  validateWopiLockRead,
  validateWopiLockRequest,
  type WopiLockRepo,
} from "./wopi-lock-state.js";

export function createWopiLockRepo(db: Db): WopiLockRepo {
  return createWopiLockRepoWithRunner((callback) => db.transaction(callback));
}

/** Internal composition seam for the office write coordinator. */
export function createWopiLockRepoWithRunner(
  runTransaction: OfficeTransactionRunner,
  assertActive: () => void = () => {},
): WopiLockRepo {
  const repo: WopiLockRepo = {
    async get(fileId, now) {
      assertActive();
      validateWopiLockRead(fileId, now);
      return repo.withFileLock(fileId, (locked) => locked.get(now));
    },
    async apply(request) {
      assertActive();
      validateWopiLockRequest(request);
      return repo.withFileLock(request.fileId, (locked) => locked.apply(request));
    },
    async withFileLock(fileId, callback) {
      assertActive();
      validateWopiFileId(fileId);
      return runTransaction(async (tx) => {
        // A row lock alone cannot serialize two acquisitions of an absent file.
        // Hash collisions only serialize unrelated files; all reads still use fileId.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${fileId}, 0))`);
        return callback({
          async get(now) {
            assertActive();
            validateWopiLockRead(fileId, now);
            const [row] = await tx
              .select({ lockId: wopiLocks.lockId })
              .from(wopiLocks)
              .where(and(eq(wopiLocks.fileId, fileId), gt(wopiLocks.expiresAt, now)))
              .limit(1);
            return row?.lockId ?? null;
          },
          async apply(input) {
            assertActive();
            const request = { ...input, fileId };
            validateWopiLockRequest(request);
            const [row] = await tx
              .select()
              .from(wopiLocks)
              .where(eq(wopiLocks.fileId, fileId))
              .limit(1);
            const transition = transitionWopiLock(
              row === undefined ? null : { lockId: row.lockId, expiresAt: row.expiresAt.getTime() },
              request,
            );
            if (transition.result.ok) {
              if (transition.state === null) {
                await tx.delete(wopiLocks).where(eq(wopiLocks.fileId, fileId));
              } else {
                const values = {
                  fileId,
                  lockId: transition.state.lockId,
                  expiresAt: new Date(transition.state.expiresAt),
                };
                await tx
                  .insert(wopiLocks)
                  .values(values)
                  .onConflictDoUpdate({ target: wopiLocks.fileId, set: values });
              }
            }
            return transition.result;
          },
        });
      });
    },
  };
  return repo;
}
