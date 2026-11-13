import { StorageError } from "../errors.ts";
import { normalizePath, parentPath } from "../paths.ts";
import type { StorageProvider } from "../ports/storage.ts";
import { isUnderPath, type MoveTrashLeafKind, moveTrashLeafPath } from "./recycle-folder.ts";

export interface MoveToTrashOptions {
  readonly storage: StorageProvider;
  readonly trashPath: string;
  readonly clock: () => Date;
  /** Internal receipt for the known virtual destination, after the provider move succeeds. */
  readonly onRecycled?: (originalPath: string, trashLeaf: string) => void;
}

/** Nanosecond epoch leaf name from `at`, read back by the move-layout parser. */
function leafNameFor(at: Date): string {
  return (BigInt(at.getTime()) * BigInt(1_000_000)).toString();
}

/**
 * Wraps `storage` so `deleteFile` and `deleteDir` move the entry into the
 * recycle folder at `trashPath`, at the leaf `moveTrashLeafPath` builds and
 * `createRecycleFolderTrash` reads back. The move refuses a taken leaf
 * (`overwrite: false`), so a delete never replaces an earlier trashed item.
 * Deleting something already inside the recycle folder deletes it for real,
 * so purge and empty keep working through the same wrapper.
 */
export function withMoveToTrash(options: MoveToTrashOptions): StorageProvider {
  const { storage, clock } = options;
  const trashRoot = normalizePath(options.trashPath);

  async function moveIntoTrash(path: string, kind: MoveTrashLeafKind): Promise<void> {
    const normalized = normalizePath(path);
    const leafPath = moveTrashLeafPath(trashRoot, normalized, kind, leafNameFor(clock()));
    await storage.mkdir(parentPath(leafPath), { parents: true });
    await storage.move(normalized, leafPath, { overwrite: false });
    options.onRecycled?.(normalized, leafPath);
  }

  return {
    ...storage,
    async deleteFile(path) {
      if (isUnderPath(trashRoot, path) || normalizePath(path) === trashRoot) {
        await storage.deleteFile(path);
        return;
      }
      await moveIntoTrash(path, "file");
    },
    async deleteDir(path) {
      const normalized = normalizePath(path);
      if (isUnderPath(trashRoot, normalized) || normalized === trashRoot) {
        await storage.deleteDir(path);
        return;
      }
      if (isUnderPath(normalized, trashRoot)) {
        throw new StorageError("bad_request", "cannot recycle a parent of the trash folder");
      }
      await moveIntoTrash(normalized, "dir");
    },
  };
}
