import { isUnderPath, normalizePath } from "@fdrive/core";
import type { MetadataService } from "./service.js";

/**
 * True when moving `from` to `to` puts it in the Trash folder at `trashPath`
 * (`null` while Trash is off): `to` is that folder or inside it, and `from`
 * is not. Whoever reports the move (fdrive's own routes or the indexer, which
 * sees fdrive's Trash as a move into `<trash>/.fdrive-move-v1/…`), records
 * kept by path treat it as a trash (`MetadataService.onTrashed`), so both
 * leave them in the same place. A move out of the Trash (a restore) or within
 * it is an ordinary move.
 */
export function isMoveIntoTrash(trashPath: string | null, from: string, to: string): boolean {
  if (trashPath === null) return false;
  const trash = normalizePath(trashPath);
  const inTrash = (path: string) => normalizePath(path) === trash || isUnderPath(trash, path);
  return inTrash(to) && !inTrash(from);
}

/**
 * `metadata`, with a move into the login's Trash (`isMoveIntoTrash`) handled
 * as `onTrashed`, as when fdrive moves an item to Trash itself: tags and
 * favorites stay at the original path, and folders shared with people
 * follow the item into Trash, where the person it is shared with cannot
 * reach it.
 */
export function withTrashMoves(
  metadata: MetadataService,
  /** The login's Trash folder while Trash is on, else `null`. */
  trashPathFor: (identityId: string) => Promise<string | null>,
): MetadataService {
  return {
    ...metadata,
    async onMoved(identityId, from, to, isDir) {
      if (isMoveIntoTrash(await trashPathFor(identityId), from, to)) {
        await metadata.onTrashed(identityId, from, isDir, to);
        return;
      }
      await metadata.onMoved(identityId, from, to, isDir);
    },
  };
}
