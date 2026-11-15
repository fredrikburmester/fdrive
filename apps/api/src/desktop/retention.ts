import { isStorageError, type StorageProvider } from "@fdrive/core";
import type { DesktopOperationRecord, DesktopRepo, DesktopRetention } from "@fdrive/db";
import type { SystemEventLog } from "../system/event-log.js";
import { DESKTOP_INTERNAL_ROOT } from "./files.js";

export const DESKTOP_RETENTION: DesktopRetention = {
  idleMs: 24 * 60 * 60_000,
  conflictMs: 7 * 24 * 60 * 60_000,
  retainMs: 30 * 24 * 60 * 60_000,
};

/**
 * Where one operation stages what it publishes, in its owner's files: each
 * upload attempt's body, and a new folder, at `<this>/<attempt>`. Hidden
 * from every reader like the rest of `/.fdrive-desktop`.
 */
export function incomingPath(identityId: string, operationId: string) {
  return `${DESKTOP_INTERNAL_ROOT}/${identityId}/incoming/${operationId}`;
}

/**
 * Deletes what one operation staged, once it can no longer publish any of
 * it: settled, cancelled or forgotten. Only fdrive writes under `incoming`,
 * so the whole folder goes, with any partial upload a crash left in it.
 * `storage` must be built without Trash settings, or the delete would move
 * fdrive's bookkeeping into its owner's Trash.
 */
export async function removeIncoming(
  storage: StorageProvider,
  identityId: string,
  operationId: string,
) {
  try {
    await storage.deleteDir(incomingPath(identityId, operationId));
  } catch (error) {
    if (!(isStorageError(error) && error.kind === "not_found")) throw error;
  }
}

export interface DesktopRetentionDeps {
  repo: Pick<DesktopRepo, "expired" | "transition" | "forget">;
  /**
   * Storage for an identity without the Trash wrapper: what retention removes
   * is fdrive's own bookkeeping, deleted for real rather than moved to Trash.
   */
  storageForIdentity: (identityId: string) => Promise<StorageProvider>;
  clock: () => Date;
  retention?: DesktopRetention;
  eventLog: Pick<SystemEventLog, "record">;
}

/**
 * Two bounded jobs: cancel uploads that never finished (and conflicts nobody
 * retried), and forget operations the app is done with, each with what it
 * staged. Ready and committing operations are never touched: their staged
 * files may still be published. Failures defer to the next pass.
 */
export function createDesktopRetention(deps: DesktopRetentionDeps) {
  const retention = deps.retention ?? DESKTOP_RETENTION;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  async function discard(op: DesktopOperationRecord) {
    await removeIncoming(await deps.storageForIdentity(op.identityId), op.identityId, op.id);
  }
  async function sweep() {
    const now = deps.clock();
    const results = { cancelled: 0, forgotten: 0, deferred: 0 };
    for (const op of await deps.repo.expired(now, retention, 32)) {
      if (stopped) break;
      try {
        if (["receiving", "uploading", "conflict"].includes(op.state)) {
          if (
            await deps.repo.transition(op.identityId, op.accountId, op.id, op.state, "cancelled")
          ) {
            await discard(op);
            results.cancelled += 1;
          }
          continue;
        }
        await discard(op);
        await deps.repo.forget(op.identityId, op.accountId, op.id);
        results.forgotten += 1;
      } catch (error) {
        results.deferred += 1;
        deps.eventLog.record("general", "warn", "Mac write cleanup deferred", {
          identityId: op.identityId,
          operationId: op.id,
          state: op.state,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
  function run() {
    if (stopped || active) return active ?? Promise.resolve();
    active = sweep()
      .then(() => undefined)
      .catch((error: unknown) => {
        deps.eventLog.record("general", "error", "Mac write cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  }
  return {
    sweep,
    start() {
      if (timer || stopped) return;
      run();
      timer = setInterval(run, 10 * 60_000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
