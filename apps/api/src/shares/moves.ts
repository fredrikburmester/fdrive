import type { DesktopShareMove, ShareRepo } from "@fdrive/db";
import type { PathFollower } from "../metadata/service.ts";

/** A path as it lies in its owner's files: the owner's login and the owner's own path. */
export interface OwnedPath {
  readonly identityId: string;
  readonly path: string;
}

export interface ShareMovesDeps {
  readonly shares: Pick<ShareRepo, "movePrefix" | "deletePrefix">;
  /**
   * Where a login's path lies in its owner's files (`LocalGrantService.ownerPath`):
   * a path in a folder shared with the login belongs to that folder's owner.
   * `null` when nobody here owns it. Without it every path is the login's own.
   */
  readonly ownerPath?: (identityId: string, path: string) => Promise<OwnedPath | null>;
}

export interface ShareMoves extends PathFollower {
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
 * above it, through the hooks every other path-keyed record follows (fdrive's
 * own moves, MCP and the AI, Office renames, Trash and its restores, moves
 * the indexer reports) and through the Mac's metadata recovery (`resolve`).
 *
 * That includes moves to where no link may reach: into the Trash, the Mac's
 * Trash, a backup folder or `Shared with me`. The public routes refuse those
 * paths, so the link shows not found there, and follows the item back out
 * on a restore. A delete removes the item's paths from its links, and a link
 * left with none goes. Purging something from the Trash leaves its link at
 * the Trash path, which no link may reach and no other item can take.
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

  async function resolve(identityId: string, from: string, to: string) {
    if (from === to) return null;
    const source = await ownerPath(identityId, from);
    if (source === null || source.path === "/") return null;
    const target = await ownerPath(identityId, to);
    if (target?.identityId === source.identityId)
      return target.path === source.path || target.path === "/"
        ? null
        : { identityId: source.identityId, from: source.path, to: target.path };
    // Into someone else's files: its owner still finds it under `Shared with me`.
    if (source.identityId === identityId && to !== "/") return { identityId, from, to };
    return { identityId: source.identityId, from: source.path, to: null };
  }

  async function follow(identityId: string, from: string, to: string, isDir: boolean) {
    const move = await resolve(identityId, from, to);
    if (move === null) return;
    if (move.to === null) await deps.shares.deletePrefix(move.identityId, move.from, isDir);
    else await deps.shares.movePrefix(move.identityId, move.from, move.to, isDir);
  }

  async function drop(identityId: string, path: string, isDir: boolean) {
    const owned = await ownerPath(identityId, path);
    if (owned !== null && owned.path !== "/")
      await deps.shares.deletePrefix(owned.identityId, owned.path, isDir);
  }

  return {
    resolve,
    onMoved: follow,
    onDeleted: drop,
    async onTrashed(identityId, path, leaf, isDir) {
      // Without the Trash path the item is as good as gone for its links.
      if (leaf === null) await drop(identityId, path, isDir);
      else await follow(identityId, path, leaf, isDir);
    },
  };
}
