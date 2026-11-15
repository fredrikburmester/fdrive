import type { LocalGrantService } from "../local/grants.js";
import type { PathFollower } from "../metadata/service.js";
import type { OfficeFileRepo } from "./types.ts";

/**
 * Office documents follow their files like any other path-keyed record:
 * every move, rename and delete reaches the registry through the metadata
 * hooks (`withFollowers`), whoever made it (fdrive's own routes, MCP and the
 * AI, Office renames, Trash and its restores, and moves made outside fdrive that the
 * change journal holds, followed once as their owner's). A
 * document keeps its id wherever its file goes, into the Trash and back out
 * too, and loses it when the file is deleted.
 *
 * Paths are translated to their owner's files first (`ownerPath`), so a
 * move by someone a folder is shared with moves the owner's document, and a
 * move from one owner's files into another's (a writable shared folder)
 * takes the document along.
 */
export function createOfficeMoves(deps: {
  readonly files: Pick<OfficeFileRepo, "movePrefix" | "deletePrefix">;
  readonly grants: Pick<LocalGrantService, "ownerPath">;
  readonly clock: () => Date;
}): PathFollower {
  return {
    async onMoved(identityId, from, to) {
      const [source, target] = await Promise.all([
        deps.grants.ownerPath(identityId, from),
        deps.grants.ownerPath(identityId, to),
      ]);
      // An owner's root never moves; neither does a folder shared as a whole.
      if (source.path === "/" || target.path === "/") return;
      await deps.files.movePrefix({ from: source, to: target, at: deps.clock() });
    },
    async onDeleted(identityId, path) {
      const owned = await deps.grants.ownerPath(identityId, path);
      if (owned.path !== "/") await deps.files.deletePrefix({ ...owned, at: deps.clock() });
    },
  };
}
