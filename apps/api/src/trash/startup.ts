import { isStorageError, type StorageProvider } from "@fdrive/core";
import type { DesktopRepo, IdentityRepo, TrashItemRepo } from "@fdrive/db";
import type { SystemEventLog } from "../system/event-log.js";
import type { TrashItems } from "./items.js";
import { oldTrashLeaves, removeEmptyOldFolders } from "./old-layout.js";

export interface TrashStartupDeps {
  readonly items: Pick<TrashItems, "settle" | "adopt">;
  readonly repo: Pick<TrashItemRepo, "pending">;
  readonly identities: Pick<IdentityRepo, "listAll">;
  /** A login's own files, whether or not its user may sign in now. */
  readonly homeOf: (identityId: string) => Promise<StorageProvider>;
  /** The Mac's own old Trash, from before Finder's Trash became fdrive's. */
  readonly desktop: Pick<DesktopRepo, "oldTrash" | "remove">;
  readonly clock: () => Date;
  readonly eventLog: Pick<SystemEventLog, "record">;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the API does with Trash when it starts, before it serves anyone, so
 * nothing else is on its way into Trash meanwhile:
 *
 * 1. It settles each item an interrupted delete left on its way into Trash
 *    (`TrashItems.settle`): in Trash, it arrives; still where it was, it
 *    stays there.
 * 2. It moves each item Trash's old layout still holds into a folder of its
 *    own, with the path and time its old place names, so Days in Trash
 *    counts as before. Its row is written first, then one rename moves it,
 *    then it arrives with what followed it into the old place; whatever
 *    interrupts that, the next start finishes or repeats it.
 * 3. It moves each item the Mac's own old Trash still holds, as deleted now.
 *
 * Nothing is deleted. An item that cannot move stays where it is, and is
 * tried again at the next start. Steps 2 and 3 go once nothing is left for
 * them on the owner's server.
 */
export async function settleTrashAtStart(deps: TrashStartupDeps): Promise<void> {
  const warn = (message: string, detail: Record<string, unknown>) =>
    deps.eventLog.record("general", "warn", message, detail);

  for (const item of await deps.repo.pending()) {
    try {
      await deps.items.settle(item);
    } catch (error) {
      warn("An item on its way into Trash waits for the next start", {
        identityId: item.identityId,
        id: item.id,
        error: errorText(error),
      });
    }
  }

  let moved = 0;
  for (const identity of await deps.identities.listAll()) {
    try {
      const home = await deps.homeOf(identity.id);
      for (const leaf of await oldTrashLeaves(home)) {
        try {
          await deps.items.adopt(identity.id, leaf.path, leaf.originalPath, leaf.deletedAt);
          moved += 1;
        } catch (error) {
          warn("An item in Trash's old layout stays there", {
            identityId: identity.id,
            path: leaf.path,
            error: errorText(error),
          });
        }
      }
      await removeEmptyOldFolders(home);
    } catch (error) {
      warn("Trash's old layout stays until the next start", {
        identityId: identity.id,
        error: errorText(error),
      });
    }
  }
  if (moved > 0)
    deps.eventLog.record("general", "info", "Moved Trash's old layout into Trash", { moved });

  let adopted = 0;
  for (const item of await deps.desktop.oldTrash()) {
    try {
      await deps.items.adopt(item.identityId, item.path, item.originalPath, deps.clock());
      adopted += 1;
    } catch (error) {
      // Gone from disk: there is nothing left to move.
      if (isStorageError(error) && error.kind === "not_found")
        await deps.desktop.remove(item.identityId, item.path);
      else
        warn("An item in the Mac's old Trash stays there", {
          identityId: item.identityId,
          path: item.path,
          error: errorText(error),
        });
    }
  }
  if (adopted > 0)
    deps.eventLog.record("general", "info", "Moved the Mac's old Trash into Trash", { adopted });
}
