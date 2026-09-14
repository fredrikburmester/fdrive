import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isStorageError, parentPath, type StorageProvider } from "@fdrive/core";
import type { DesktopOperationRecord, DesktopRepo, DesktopRetention } from "@fdrive/db";
import type { SystemEventLog } from "../system/event-log.js";
import { DESKTOP_INTERNAL_ROOT } from "./files.js";

export const DEFAULT_DESKTOP_RETENTION: DesktopRetention = {
  idleMs: 24 * 60 * 60_000,
  conflictMs: 7 * 24 * 60 * 60_000,
  retainMs: 30 * 24 * 60 * 60_000,
};
const RECOVERY_FILES = new Set(["incoming", "previous", "renamed-original"]);
const ATTEMPT = /^[a-f0-9-]{36}$/;

export interface DesktopRetentionDeps {
  repo: Pick<DesktopRepo, "expired" | "transition" | "reclaim">;
  stateDir?: string;
  storageForIdentity: (identityId: string) => Promise<StorageProvider>;
  clock: () => Date;
  retention?: DesktopRetention;
  eventLog: Pick<SystemEventLog, "record">;
}

/** Remove one operation's recovery tree. Anything unexpected aborts before deletion. */
export async function removeRecoveryTree(storage: StorageProvider, internal: string) {
  let siblings: Awaited<ReturnType<StorageProvider["list"]>>;
  try {
    siblings = await storage.list(parentPath(internal));
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") return;
    throw error;
  }
  const root = siblings.find((entry) => entry.path === internal);
  if (!root) return;
  if (root.kind !== "dir") throw Error(`Unexpected recovery entry ${internal}`);
  const attempts = await storage.list(internal);
  const plan: { files: string[]; directory: string }[] = [];
  for (const attempt of attempts) {
    if (attempt.kind !== "dir" || !ATTEMPT.test(attempt.name))
      throw Error(`Unexpected recovery entry ${attempt.path}`);
    const files = await storage.list(attempt.path);
    for (const file of files)
      if (file.kind !== "file" || !RECOVERY_FILES.has(file.name))
        throw Error(`Unexpected recovery entry ${file.path}`);
    plan.push({ files: files.map((file) => file.path), directory: attempt.path });
  }
  // Every entry was verified before the first deletion.
  for (const attempt of plan) {
    for (const file of attempt.files) await storage.deleteFile(file);
    await storage.deleteDir(attempt.directory);
  }
  await storage.deleteDir(internal);
}

/** Bounded, lease-fenced reclamation of expired uploads, stale conflicts and old backups.
 * Uncertain and committing operations are never touched; failures defer to the next pass. */
export function createDesktopRetention(deps: DesktopRetentionDeps) {
  const retention = deps.retention ?? DEFAULT_DESKTOP_RETENTION;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  async function spool(op: DesktopOperationRecord) {
    if (!deps.stateDir) return;
    await rm(join(deps.stateDir, op.identityId, op.id), { recursive: true, force: true });
  }
  async function reclaim(op: DesktopOperationRecord, now: Date) {
    const storage = await deps.storageForIdentity(op.identityId);
    const internal = `${DESKTOP_INTERNAL_ROOT}/${op.identityId}/${op.id}`;
    const remove = (scoped: StorageProvider) => removeRecoveryTree(scoped, internal);
    if (storage.withWriteLease) await storage.withWriteLease(remove);
    else await remove(storage);
    await spool(op);
    await deps.repo.reclaim(op.identityId, op.accountId, op.id, now);
  }
  async function sweep() {
    const now = deps.clock();
    const results = { cancelled: 0, reclaimed: 0, deferred: 0 };
    for (const op of await deps.repo.expired(now, retention, 32)) {
      if (stopped) break;
      try {
        if (["receiving", "uploading", "conflict"].includes(op.state)) {
          if (
            await deps.repo.transition(op.identityId, op.accountId, op.id, op.state, "cancelled")
          ) {
            await spool(op);
            results.cancelled += 1;
          }
          continue;
        }
        await reclaim(op, now);
        results.reclaimed += 1;
      } catch (error) {
        results.deferred += 1;
        deps.eventLog.record("general", "warn", "Mac write recovery reclamation deferred", {
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
        deps.eventLog.record("general", "error", "Mac write recovery reclamation failed", {
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
