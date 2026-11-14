import type { DesktopShareMove, ShareRepo } from "@fdrive/db";
import type { PathFollower } from "../metadata/service.ts";
import { hiddenFromLinks, restrictedRoots } from "./owned-access.ts";

/** A path as it lies in its owner's files: the owner's login and the owner's own path. */
export interface OwnedPath {
  readonly identityId: string;
  readonly path: string;
}

export interface ShareMovesDeps {
  readonly shares: Pick<ShareRepo, "movePrefix">;
  /** The owner's Trash folder while Trash is on, which no link follows a move into. */
  readonly trashPathFor: (identityId: string) => Promise<string | null>;
  /**
   * Where a login's path lies in its owner's files (`LocalGrantService.ownerPath`):
   * a path in a folder shared with the login belongs to that folder's owner.
   * `null` when nobody here owns it. Without it every path is the login's own.
   */
  readonly ownerPath?: (identityId: string, path: string) => Promise<OwnedPath | null>;
}

export interface ShareMoves extends PathFollower {
  /**
   * The move public links follow when `from` moved to `to` in `identityId`'s
   * files, in their owner's files, or `null` when they stay where they are.
   */
  resolve(identityId: string, from: string, to: string): Promise<DesktopShareMove | null>;
}

/**
 * Public links follow the files they point at. A link keeps canonical paths
 * in its owner's files (`app.shares.paths`), so when something it names, or
 * a folder above it, moves, those paths move with it: through the same
 * hooks every other path-keyed record follows (fdrive's own moves, MCP and
 * the AI, Office renames, Trash restores to another place and moves the
 * indexer reports), and through the Mac's metadata recovery (`resolve`).
 *
 * A move by someone a folder is shared with counts in the owner's files:
 * within that folder the owner's links follow it; out of the owner's files,
 * or into them from elsewhere, nothing does, since a link only reaches its
 * owner's files. A link never follows a move to where no link may reach
 * (the Trash, backup folders, `Shared with me`): it keeps its path, shows
 * not found, and works again once the item is back there, as after a Trash
 * restore to the same place. A delete leaves the link as it is, for the
 * same reason.
 */
export function createShareMoves(deps: ShareMovesDeps): ShareMoves {
  const ownerPath =
    deps.ownerPath ?? (async (identityId: string, path: string) => ({ identityId, path }));

  async function resolve(identityId: string, from: string, to: string) {
    if (from === to) return null;
    const [source, target] = await Promise.all([
      ownerPath(identityId, from),
      ownerPath(identityId, to),
    ]);
    if (source === null || target === null || source.identityId !== target.identityId) return null;
    if (source.path === target.path || source.path === "/" || target.path === "/") return null;
    const restricted = restrictedRoots(await deps.trashPathFor(target.identityId));
    if (hiddenFromLinks(target.path, restricted)) return null;
    return { identityId: target.identityId, from: source.path, to: target.path };
  }

  return {
    resolve,
    async onMoved(identityId, from, to, isDir) {
      const move = await resolve(identityId, from, to);
      if (move !== null) await deps.shares.movePrefix(move.identityId, move.from, move.to, isDir);
    },
    async onDeleted() {
      // A link to something deleted keeps its path: see above.
    },
  };
}
