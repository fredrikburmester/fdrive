import type { LocalGrantService } from "../local/grants.js";
import type { OfficeFileRepo } from "./types.ts";

/**
 * Office documents follow a Mac write's move after its receipt, with the
 * rest of what is kept by path (`desktop/writes.ts`). Every other change
 * moves them with what grants access, in the file operation's transaction
 * (`files/access.ts`). A document keeps its id wherever its file goes, into
 * the Trash and back out too, and loses it when the file is deleted.
 *
 * Paths are translated to their owner's files first (`ownerPath`), so a
 * move by someone a folder is shared with moves the owner's document, and a
 * move from one owner's files into another's (a writable shared folder)
 * takes the document along.
 */
export function createOfficeMoves(deps: {
  readonly files: Pick<OfficeFileRepo, "movePrefix">;
  readonly grants: Pick<LocalGrantService, "ownerPath">;
  readonly clock: () => Date;
}): { onMoved(identityId: string, from: string, to: string): Promise<void> } {
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
  };
}
