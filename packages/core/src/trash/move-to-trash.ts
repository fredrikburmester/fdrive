import { isStorageError, StorageError } from "../errors.ts";
import { normalizePath, parentPath } from "../paths.ts";
import type { StorageProvider } from "../ports/storage.ts";
import { isUnderPath, type MoveTrashLeafKind, moveTrashLeafPath } from "./recycle-folder.ts";

export interface MoveToTrashOptions {
  readonly storage: StorageProvider;
  readonly trashPath: string;
  readonly clock: () => Date;
}

/** Nanosecond epoch leaf name from `at`, read back by the move-layout parser. */
function leafNameFor(at: Date): string {
  return (BigInt(at.getTime()) * BigInt(1_000_000)).toString();
}

/**
 * Wraps `storage` so `deleteFile` and `deleteDir` move the entry into the
 * recycle folder at `trashPath` using the versioned generic move layout from
 * `moveTrashLeafPath`, exactly what `createRecycleFolderTrash` reads in
 * `layout: "move"` mode. For providers that have no server-side trash rule of
 * their own (WebDAV, S3). Deleting something already inside the recycle folder
 * deletes it for real, so purge and empty keep working through the same wrapper.
 */
export function withMoveToTrash(options: MoveToTrashOptions): StorageProvider {
  const { storage, clock } = options;
  const trashRoot = normalizePath(options.trashPath);

  async function requireLeafFree(leafPath: string): Promise<void> {
    try {
      await storage.stat(leafPath);
    } catch (error) {
      if (isStorageError(error) && error.kind === "not_found") {
        return;
      }
      throw error;
    }
    throw new StorageError("conflict", `trash leaf already exists: ${leafPath}`);
  }

  async function moveIntoTrash(path: string, kind: MoveTrashLeafKind): Promise<void> {
    const normalized = normalizePath(path);
    const leafPath = moveTrashLeafPath(trashRoot, normalized, kind, leafNameFor(clock()));
    await requireLeafFree(leafPath);
    await storage.mkdir(parentPath(leafPath), { parents: true });
    await storage.move(normalized, leafPath, { overwrite: false });
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
