import { adoptIntoTrash, isStorageError, type StorageProvider } from "@fdrive/core";
import type { DesktopOperationRecord, DesktopRepo, DesktopRetention } from "@fdrive/db";
import type { MetadataService } from "../metadata/service.js";
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
 * so the whole folder goes, with any partial upload a crash left in it,
 * deleted for good.
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
  repo: Pick<DesktopRepo, "expired" | "transition" | "forget" | "oldTrash" | "remove">;
  /** Storage for an identity; what retention removes is fdrive's own bookkeeping. */
  storageForIdentity: (identityId: string) => Promise<StorageProvider>;
  /** What follows an item by path, its Mac handle included, into Trash. */
  metadata: Pick<MetadataService, "onMoved">;
  clock: () => Date;
  retention?: DesktopRetention;
  eventLog: Pick<SystemEventLog, "record">;
}

/**
 * Two bounded jobs: cancel uploads that never finished (and conflicts nobody
 * retried), and forget operations the app is done with, each with what it
 * staged. Ready and committing operations are never touched: their staged
 * files may still be published. Failures defer to the next pass.
 *
 * Once at start, it also moves what the Mac's own Trash held into fdrive's
 * Trash (`adoptOldTrash`).
 */
export function createDesktopRetention(deps: DesktopRetentionDeps) {
  const retention = deps.retention ?? DESKTOP_RETENTION;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let adopting: Promise<void> | undefined;
  /**
   * Moves each item the Mac's own Trash held, from before Finder's Trash
   * became fdrive's, into its user's Trash as deleted now, so Days in Trash
   * counts from this start. What follows a path follows it, its handle too,
   * so the Mac finds it in Trash under the same one. An item that cannot
   * move stays where it was and is tried at the next start; one gone from
   * disk is forgotten.
   */
  async function adoptOldTrash() {
    let adopted = 0;
    for (const item of await deps.repo.oldTrash()) {
      try {
        const storage = await deps.storageForIdentity(item.identityId);
        const moved = await adoptIntoTrash(storage, item.path, item.originalPath, deps.clock());
        await deps.metadata.onMoved(item.identityId, item.path, moved.leaf, moved.kind === "dir");
        adopted += 1;
      } catch (error) {
        if (isStorageError(error) && error.kind === "not_found")
          await deps.repo.remove(item.identityId, item.path);
        else
          deps.eventLog.record("general", "warn", "An item in the Mac's old Trash stays there", {
            identityId: item.identityId,
            path: item.path,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    }
    if (adopted > 0)
      deps.eventLog.record("general", "info", "Moved the Mac's old Trash into Trash", { adopted });
  }
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
    adoptOldTrash,
    start() {
      if (timer || stopped) return;
      adopting = adoptOldTrash().catch((error: unknown) => {
        deps.eventLog.record("general", "error", "Moving the Mac's old Trash failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      run();
      timer = setInterval(run, 10 * 60_000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await adopting;
      await active;
    },
  };
}
