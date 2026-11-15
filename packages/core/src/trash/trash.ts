import { isStorageError, StorageError } from "../errors.ts";
import { baseName, normalizePath, parentPath, splitSegments } from "../paths.ts";
import type { StorageWithoutTrash, TrashProvider } from "../ports/storage.ts";
import { isAtOrUnder, isReservedPath, TRASH_PATH } from "../reserved-paths.ts";

/** A Trash item's id: a UUID in lowercase, as `randomUUID` makes them. */
const TRASH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when `id` can name a Trash item. */
export function isTrashId(id: string): boolean {
  return TRASH_ID.test(id);
}

/** The folder Trash item `id` lives in, `/.trash/<id>`; `bad_request` for anything but an id. */
export function trashItemFolder(id: string): string {
  if (!isTrashId(id))
    throw new StorageError("bad_request", `invalid trash id: ${id}`, { details: { id } });
  return `${TRASH_PATH}/${id}`;
}

/** Where Trash item `id`, named `name`, lies: `/.trash/<id>/<name>`. */
export function trashItemPath(id: string, name: string): string {
  return `${trashItemFolder(id)}/${name}`;
}

/**
 * The Trash item `path` is or lies in, `/.trash/<id>/<name>`: its id and its
 * path. Null for anything else, Trash itself and an item's folder included.
 */
export function trashItemOf(path: string): { id: string; path: string } | null {
  const [trash, id, name] = splitSegments(path);
  if (`/${trash}` !== TRASH_PATH || id === undefined || name === undefined || !isTrashId(id))
    return null;
  return { id, path: `${TRASH_PATH}/${id}/${name}` };
}

/** Removes an item's folder once it is empty. Tidying only: a folder that cannot go stays. */
async function removeEmptyFolder(storage: StorageWithoutTrash, folder: string): Promise<void> {
  try {
    await storage.deleteEmptyDir(folder);
  } catch {
    // Not empty, or gone already.
  }
}

/**
 * A storage's Trash at `TRASH_PATH`, on its own `stat`, `mkdir`, `move`,
 * `deleteDir` and `deleteEmptyDir`: each item in a folder of its own,
 * `/.trash/<id>/<name>`, so its path in Trash is never much longer than its
 * name. Where it came from and when is the caller's to keep, by its id.
 */
export function createTrash(storage: StorageWithoutTrash): TrashProvider {
  return {
    async put(path, id) {
      const normalized = normalizePath(path);
      if (normalized === "/" || isReservedPath(normalized)) {
        throw new StorageError(
          "bad_request",
          `fdrive's own folders cannot go to Trash: ${normalized}`,
          { details: { path: normalized } },
        );
      }
      const folder = trashItemFolder(id);
      const kind = (await storage.stat(normalized)).kind === "dir" ? "dir" : "file";
      const leaf = `${folder}/${baseName(normalized)}`;
      await storage.mkdir(folder, { parents: true });
      try {
        await storage.move(normalized, leaf, { overwrite: false });
      } catch (error) {
        await removeEmptyFolder(storage, folder);
        throw error;
      }
      return { leaf, kind };
    },

    async restore(id, name, target) {
      const leaf = trashItemPath(id, name);
      const destination = normalizePath(target);
      if (isAtOrUnder(TRASH_PATH, destination)) {
        throw new StorageError("bad_request", "cannot restore into the trash folder", {
          details: { id, target: destination },
        });
      }
      // Before any folder is made for it, so a missing item leaves none behind.
      await storage.stat(leaf);
      await storage.mkdir(parentPath(destination), { parents: true });
      const restored = await storage.move(leaf, destination, { overwrite: false });
      await removeEmptyFolder(storage, trashItemFolder(id));
      return restored;
    },

    async purge(id) {
      try {
        await storage.deleteDir(trashItemFolder(id));
      } catch (error) {
        if (isStorageError(error) && error.kind === "not_found") return;
        throw error;
      }
    },
  };
}
