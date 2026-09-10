import { baseName, normalizePath, parentPath } from "../paths.ts";
import type { StorageProvider } from "../ports/storage.ts";
import { isUnderPath } from "./recycle-folder.ts";

export interface MoveToTrashOptions {
  readonly storage: StorageProvider;
  readonly trashPath: string;
  readonly clock: () => Date;
}

/** Nanosecond epoch leaf name from `at`, the layout `parseTrashLeaf` reads back. */
function leafNameFor(at: Date): string {
  return (BigInt(at.getTime()) * BigInt(1_000_000)).toString();
}

/**
 * Wraps `storage` so `deleteFile` and `deleteDir` move the entry into the
 * recycle folder at `trashPath` using the layout
 * `<trashPath>/<original dir>/<original name>/<nanosecond timestamp>`,
 * exactly what `createRecycleFolderTrash` lists and restores. For providers
 * that have no server-side trash rule of their own (WebDAV, S3). Deleting
 * something already inside the recycle folder deletes it for real, so
 * purge and empty keep working through the same wrapper.
 */
export function withMoveToTrash(options: MoveToTrashOptions): StorageProvider {
  const { storage, clock } = options;
  const trashRoot = normalizePath(options.trashPath);

  async function moveIntoTrash(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const leafDir = `${trashRoot}${parentPath(normalized) === "/" ? "" : parentPath(normalized)}/${baseName(normalized)}`;
    await storage.mkdir(leafDir, { parents: true });
    await storage.move(normalized, `${leafDir}/${leafNameFor(clock())}`);
  }

  return {
    ...storage,
    async deleteFile(path) {
      if (isUnderPath(trashRoot, path) || normalizePath(path) === trashRoot) {
        await storage.deleteFile(path);
        return;
      }
      await moveIntoTrash(path);
    },
    async deleteDir(path) {
      if (isUnderPath(trashRoot, path) || normalizePath(path) === trashRoot) {
        await storage.deleteDir(path);
        return;
      }
      await moveIntoTrash(path);
    },
  };
}
