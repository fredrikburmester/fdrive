import { isStorageError, type StorageProvider, trashItemFolder, trashItemPath } from "@fdrive/core";
import type { PendingTrashItem, TrashItemRepo } from "@fdrive/db";
import { gated, ungated, type WriteGate } from "../backups/write-gate.js";
import type { AccessFollowers } from "../files/access.js";
import type { MetadataService } from "../metadata/service.js";

/** What settling an item on its way into Trash needs to know of it. */
export type ArrivingTrashItem = Pick<
  PendingTrashItem,
  "id" | "identityId" | "name" | "kind" | "movingFrom"
>;

export interface TrashItemsDeps {
  readonly repo: TrashItemRepo;
  readonly access: Pick<AccessFollowers, "run">;
  /**
   * A login's own files, whether or not its user may sign in now: settling
   * an item is fdrive's own bookkeeping.
   */
  readonly homeOf: (identityId: string) => Promise<StorageProvider>;
  /**
   * What else is kept by path (tags, favorites, the Mac's item handles and
   * the rest), which follows an item that arrives, best effort.
   */
  readonly metadata?: Pick<MetadataService, "onMoved">;
  /**
   * The backups' write gate. Settling an item holds it, joining the write it
   * runs in (a delete that failed, a Mac commit), so a capture's snapshot
   * sees an item's row and its rename together.
   */
  readonly gate?: WriteGate;
  readonly logger?: { warn(object: Record<string, unknown>, message: string): void };
}

/**
 * What Trash holds, by its rows (`app.trash_items`): each item lies at
 * `/.trash/<id>/<name>` in its login's files. A row is written before its
 * item moves, as on its way (`begin`), and the item arrives with what follows
 * it in one transaction; whoever finds an item still on its way settles it
 * by what is on disk (`settle`). So an item is in Trash only with its row,
 * and a row lists only an item that is there.
 */
export interface TrashItems extends Pick<TrashItemRepo, "begin" | "get" | "list" | "expired"> {
  /**
   * Ends an item's way into Trash by what is on disk. There, it arrives:
   * Trash lists it, and what was kept at the path it came from follows it.
   * Not there, its row goes and the item stays where it was. Safe to run
   * twice, and alongside the operation that began it.
   */
  settle(item: ArrivingTrashItem): Promise<void>;
}

/** Whether something is at `path`; any failure but `not_found` is passed on. */
async function exists(storage: StorageProvider, path: string): Promise<boolean> {
  try {
    await storage.stat(path);
    return true;
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") return false;
    throw error;
  }
}

export function createTrashItems(deps: TrashItemsDeps): TrashItems {
  const { repo } = deps;
  const gate = deps.gate ?? ungated;

  async function settleIn(item: ArrivingTrashItem): Promise<void> {
    const storage = await deps.homeOf(item.identityId);
    const leaf = trashItemPath(item.id, item.name);
    if (!(await exists(storage, leaf))) {
      await repo.abandon(item.id);
      try {
        await storage.deleteEmptyDir(trashItemFolder(item.id));
      } catch {
        // Never made, or the item's folder holds something after all.
      }
      return;
    }
    const directory = item.kind === "dir";
    // Holds where it came from, so nothing new there is followed by mistake.
    await deps.access.run(item.identityId, { vacates: [item.movingFrom] }, async (follow) => {
      if (!(await follow.trash.entered(item.id, leaf))) return;
      try {
        await deps.metadata?.onMoved(item.identityId, item.movingFrom, leaf, directory);
      } catch (error) {
        deps.logger?.warn(
          { err: error, id: item.id, from: item.movingFrom },
          "an item arrived in Trash; its tags, favorites or Mac handle could not follow it",
        );
      }
      await follow.moved(item.identityId, item.movingFrom, leaf, directory);
    });
  }

  return {
    begin: (item) => repo.begin(item),
    get: (identityId, id) => repo.get(identityId, id),
    list: (identityId, limit) => repo.list(identityId, limit),
    expired: (identityId, before) => repo.expired(identityId, before),
    settle: (item) => gated(gate, () => settleIn(item)),
  };
}
