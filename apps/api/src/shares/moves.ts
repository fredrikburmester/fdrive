import type { DesktopShareMove } from "@fdrive/db";

/** A path as it lies in its owner's files: the owner's login and the owner's own path. */
export interface OwnedPath {
  readonly identityId: string;
  readonly path: string;
}

export interface ShareMovesDeps {
  /**
   * Where a login's path lies in its owner's files (`LocalGrantService.ownerPath`):
   * a path in a folder shared with the login belongs to that folder's owner.
   * Without it every path is the login's own.
   */
  readonly ownerPath?: (identityId: string, path: string) => Promise<OwnedPath>;
}

export interface ShareMoves {
  /**
   * What public links do when `from` moved to `to` in `identityId`'s files,
   * in their owner's files: follow to `to`, or drop `from` (`to: null`) when
   * the item left the owner's files. `null` when there is nothing to do.
   */
  resolve(identityId: string, from: string, to: string): Promise<DesktopShareMove | null>;
}

/**
 * Public links follow the item they point at, wherever it goes. A link keeps
 * canonical paths in its owner's files (`app.shares.paths`); left behind at
 * a path, it would serve whatever is put there next, content its owner never
 * shared. So a link follows every move of what it names, or of a folder
 * above it: with every file operation's storage call (`files/access.ts`),
 * with the receipt of each Mac write, and once the change journal holds a
 * change made outside fdrive.
 *
 * That includes moves to where no link may reach: into the Trash, the Mac's
 * Trash, a backup folder or `Shared with me`. The public routes refuse those
 * paths (fdrive's Trash layout wherever it lies), so the link shows
 * not found there, and follows the item back out on a restore. A delete, or
 * a purge from the Trash, removes the item's paths from its links, and a
 * link left with none goes.
 *
 * A move by someone a folder is shared with counts in the owner's files:
 * within that folder the owner's links follow it. Taken out of the owner's
 * files, the item is gone for the owner's links. Moved by its owner into a
 * folder someone else shares with them, it is followed there, under
 * `Shared with me`, which no link reaches.
 */
export function createShareMoves(deps: ShareMovesDeps): ShareMoves {
  const ownerPath =
    deps.ownerPath ?? (async (identityId: string, path: string) => ({ identityId, path }));

  return {
    async resolve(identityId, from, to) {
      if (from === to) return null;
      const source = await ownerPath(identityId, from);
      if (source.path === "/") return null;
      const target = await ownerPath(identityId, to);
      if (target.identityId === source.identityId)
        return target.path === source.path || target.path === "/"
          ? null
          : { identityId: source.identityId, from: source.path, to: target.path };
      // Into someone else's files: its owner still finds it under `Shared with me`.
      if (source.identityId === identityId && to !== "/") return { identityId, from, to };
      return { identityId: source.identityId, from: source.path, to: null };
    },
  };
}
