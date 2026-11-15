import {
  type FileEntry,
  isStorageError,
  normalizePath,
  OLD_TRASH_LAYOUT,
  relativeTo,
  type StorageProvider,
  TRASH_PATH,
} from "@fdrive/core";

/**
 * Trash's old layout, which a start-up step moves into Trash's folders and
 * goes with it: `/.trash/.fdrive-move-v1/<kind>/p/<segment>/…/v/<timestamp>`,
 * each segment of the path an item was deleted from as it was, between `p`
 * markers, and the time it was deleted in nanoseconds.
 */
export const OLD_TRASH_ROOT = `${TRASH_PATH}/${OLD_TRASH_LAYOUT}`;

/** A leaf of the old layout, as its path says. */
export interface OldTrashLeaf {
  readonly path: string;
  readonly originalPath: string;
  readonly deletedAt: Date;
}

/** A leaf's name is 1 to 20 ASCII digits: a nanosecond epoch timestamp. */
const TIMESTAMP = /^[0-9]{1,20}$/;

/** Reads the leaf `path` names in the old layout; null for anything else. */
export function parseOldTrashLeaf(path: string): OldTrashLeaf | null {
  const relative = relativeTo(OLD_TRASH_ROOT, path);
  if (relative === null || relative === "") return null;
  const segments = relative.split("/");
  const [kind] = segments;
  const timestamp = segments.at(-1) as string;
  const encoded = segments.slice(1, -2);
  if (
    (kind !== "file" && kind !== "dir") ||
    segments.at(-2) !== "v" ||
    !TIMESTAMP.test(timestamp) ||
    encoded.length === 0 ||
    encoded.length % 2 !== 0 ||
    encoded.some((segment, at) => at % 2 === 0 && segment !== "p")
  )
    return null;
  return {
    path: normalizePath(path),
    originalPath: `/${encoded.filter((_, at) => at % 2 === 1).join("/")}`,
    deletedAt: new Date(Number(BigInt(timestamp) / 1_000_000n)),
  };
}

/** What a folder holds, or nothing once it is gone. */
async function children(storage: StorageProvider, path: string): Promise<FileEntry[]> {
  try {
    return await storage.list(path);
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") return [];
    throw error;
  }
}

/** Every leaf the old layout holds, folder by folder. */
export async function oldTrashLeaves(storage: StorageProvider): Promise<OldTrashLeaf[]> {
  const leaves: OldTrashLeaf[] = [];
  const folders = [OLD_TRASH_ROOT];
  for (const folder of folders)
    for (const child of await children(storage, folder)) {
      const leaf = parseOldTrashLeaf(child.path);
      if (leaf !== null) leaves.push(leaf);
      else if (child.kind === "dir") folders.push(child.path);
    }
  return leaves;
}

/**
 * Removes the old layout's folders that hold nothing, deepest first, and
 * the layout itself once it is empty. Never a leaf, which is an item even
 * when it is an empty folder, and never anything with something in it.
 */
export async function removeEmptyOldFolders(
  storage: StorageProvider,
  folder = OLD_TRASH_ROOT,
): Promise<void> {
  for (const child of await children(storage, folder))
    if (child.kind === "dir" && parseOldTrashLeaf(child.path) === null)
      await removeEmptyOldFolders(storage, child.path);
  try {
    await storage.deleteEmptyDir(folder);
  } catch {
    // Something is still in it, or it is gone already.
  }
}
