import { type EntryStat, isStorageError, parentPath, type StorageProvider } from "@fdrive/core";
import type { ActivityObservations } from "../activity/observations.ts";
import { type MetadataService, type PathFollower, withFollowers } from "../metadata/service.ts";
import type { Login, SeenChange } from "./journal.ts";

export interface OutsideChangesDeps {
  /** What each login keeps by path: tags, favorites, folder views, recents, chat references. */
  readonly metadata: MetadataService;
  /**
   * What keeps the owner's paths for everyone (shares with people, public
   * links, Office files), followed first and only for the owner.
   */
  readonly followers: readonly PathFollower[];
  readonly storageFor: (identityId: string) => Promise<StorageProvider>;
  readonly observations: ActivityObservations;
}

/**
 * What is at `path` now: its stat, `"gone"` when it is not found and its
 * folder still lists (so the folder, or the whole files folder, is not
 * merely unreachable), or `null` when that cannot be told.
 */
async function look(storage: StorageProvider, path: string): Promise<EntryStat | "gone" | null> {
  try {
    return await storage.stat(path);
  } catch (error) {
    if (!isStorageError(error) || error.kind !== "not_found") return null;
  }
  try {
    await storage.list(parentPath(path));
    return "gone";
  } catch {
    return null;
  }
}

/**
 * Brings what is kept by path along with a change made outside fdrive, for
 * one login that sees it (`JournalFanoutDeps.outside`). A move both of whose
 * ends the login sees moves its tags, favorites and the rest, and records
 * tracked files' new place in personal activity; a move out of what it sees
 * drops them. A row that says to look again looks: a path that is gone drops
 * them too, and one still there is compared with what history last
 * confirmed. A move's row does not say whether it was a folder, so it is
 * followed as one, which for a file matches nothing more.
 *
 * Shares with people, public links and Office files keep the owner's paths
 * for everyone, so they follow once, with the owner's pass (the home folder
 * the row's path is in). Followed from someone a folder is shared with, a
 * move only they see one end of would drop them for the owner too.
 */
export function createOutsideChanges(deps: OutsideChangesDeps) {
  const ownerMetadata = withFollowers(deps.metadata, deps.followers);
  return async (login: Login, seen: SeenChange): Promise<void> => {
    const { path, target, change } = seen;
    if (path === null) return;
    const actor = { accountId: login.accountId, identityId: login.id };
    const owner = change.path.split("/", 1)[0] === login.username;
    const metadata = owner ? ownerMetadata : deps.metadata;
    if (change.targetPath !== null) {
      if (target === null) {
        await metadata.onDeleted(login.id, path, true);
        await deps.observations.absent(actor, path, "left_scope");
        return;
      }
      await metadata.onMoved(login.id, path, target, true);
      await deps.observations.moved(actor, await deps.storageFor(login.id), path, target);
      return;
    }
    const now = await look(await deps.storageFor(login.id), path);
    if (now === "gone") {
      await metadata.onDeleted(login.id, path, true);
      await deps.observations.absent(actor, path, "missing");
    } else if (now !== null) {
      await deps.observations.present(actor, path, now);
    }
  };
}
