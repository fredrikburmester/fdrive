import type { FileEntry } from "../entries.ts";
import { isStorageError, StorageError } from "../errors.ts";
import { normalizePath, parentPath, relativeTo } from "../paths.ts";
import type {
  EntryStat,
  StorageWithoutTrash,
  TrashEntry,
  TrashedItem,
  TrashListing,
  TrashProvider,
  TrashRestoreResult,
} from "../ports/storage.ts";
import { isReservedPath, TRASH_PATH } from "../reserved-paths.ts";
import {
  isUnderPath,
  moveTrashLeafPath,
  moveTrashRootPath,
  parseMoveTrashLeaf,
  trashLeafPath,
} from "./recycle-folder.ts";

const DEFAULT_LIMIT = 10000;

export interface CreateRecycleFolderTrashOptions {
  /** The storage whose files the Trash moves; its own folder is `TRASH_PATH`. */
  readonly storage: StorageWithoutTrash;
  /** Names each new leaf by the time it was made. */
  readonly clock: () => Date;
  readonly limit?: number;
}

type Storage = StorageWithoutTrash;

/** Nanosecond epoch leaf name from `at`, read back by the move-layout parser. */
function leafNameFor(at: Date): string {
  return (BigInt(at.getTime()) * BigInt(1_000_000)).toString();
}

/**
 * Moves the file or folder at `path` in `storage` into its Trash at
 * `TRASH_PATH`, at the leaf `moveTrashLeafPath` builds for `originalPath`
 * and `at`. The move refuses a taken leaf (`overwrite: false`), so an item
 * never replaces an earlier one. The root and fdrive's own folders, Trash
 * included, are refused as the original path: deleting inside Trash is a
 * permanent delete.
 */
async function moveIntoTrash(
  storage: Storage,
  path: string,
  at: Date,
  originalPath = path,
): Promise<TrashedItem> {
  const original = normalizePath(originalPath);
  if (original === "/" || isReservedPath(original)) {
    throw new StorageError("bad_request", `fdrive's own folders cannot go to Trash: ${original}`, {
      details: { path: original },
    });
  }
  const normalized = normalizePath(path);
  const kind = (await storage.stat(normalized)).kind === "dir" ? "dir" : "file";
  const leaf = moveTrashLeafPath(TRASH_PATH, original, kind, leafNameFor(at));
  await storage.mkdir(parentPath(leaf), { parents: true });
  await storage.move(normalized, leaf, { overwrite: false });
  return { leaf, kind };
}

/**
 * Moves what fdrive kept at `path`, in one of its own folders, into
 * `storage`'s Trash as an item deleted from `originalPath` at `at`, so Trash
 * lists, restores and expires it like any other. FDrive for Mac kept a Trash
 * of its own before Finder's Trash became fdrive's; its items come over this
 * way.
 */
export function adoptIntoTrash(
  storage: StorageWithoutTrash,
  path: string,
  originalPath: string,
  at: Date,
): Promise<TrashedItem> {
  return moveIntoTrash(storage, path, at, originalPath);
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function compareEntries(a: TrashEntry, b: TrashEntry): number {
  const byDate = b.deletedAt.getTime() - a.deletedAt.getTime();
  return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
}

/**
 * Removes `dir` and then each parent while it is empty, stopping below the
 * layout root. Removal is never recursive, so a folder something was moved
 * into meanwhile stays. This is tidying after an operation that already
 * succeeded: the first folder that cannot go, for whatever reason (not
 * empty, already gone), ends the climb without failing anything.
 */
async function removeEmptyFolders(storage: Storage, trashRoot: string, dir: string): Promise<void> {
  const layoutRoot = moveTrashRootPath(trashRoot);
  for (let at = dir; isUnderPath(layoutRoot, at); at = parentPath(at)) {
    try {
      await storage.deleteEmptyDir(at);
    } catch {
      return;
    }
  }
}

async function walk(
  storage: Storage,
  trashRoot: string,
  options: { limit: number; prune: boolean; signal: AbortSignal | undefined },
): Promise<TrashListing> {
  const { limit, prune, signal } = options;
  const entries: TrashEntry[] = [];
  let truncated = false;
  const queue: string[] = [moveTrashRootPath(trashRoot)];

  for (const dir of queue) {
    checkAborted(signal);
    if (truncated) {
      break;
    }
    let children: FileEntry[];
    try {
      children = await storage.list(dir);
    } catch (error) {
      // A folder that is gone holds nothing: the namespace before the first
      // delete, or a folder a restore or purge removed since it was queued.
      if (isStorageError(error) && error.kind === "not_found") {
        continue;
      }
      throw error;
    }
    if (prune && children.length === 0) {
      await removeEmptyFolders(storage, trashRoot, dir);
    }
    for (const child of children) {
      const parsed = parseMoveTrashLeaf(trashRoot, child.path);
      if (parsed === null) {
        if (child.kind === "dir") {
          queue.push(child.path);
        }
        continue;
      }
      if (child.kind !== parsed.kind) {
        continue;
      }
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push({
        // child.path was returned by storage.list(dir), and dir is always
        // trashRoot or a descendant reached from it, so relativeTo always
        // succeeds; the cast works around noUncheckedIndexedAccess not
        // knowing that.
        id: relativeTo(trashRoot, child.path) as string,
        originalPath: parsed.originalPath,
        name: parsed.name,
        size: child.size,
        deletedAt: parsed.deletedAt,
      });
    }
  }

  entries.sort(compareEntries);
  return { entries, truncated };
}

/**
 * Stats a leaf only after its layout has identified the expected kind. This
 * runs before restore mutates either the leaf or its destination.
 */
async function statLeaf(
  storage: Storage,
  id: string,
  leafPath: string,
  expectedKind: "file" | "dir",
): Promise<EntryStat> {
  const stat = await storage.stat(leafPath);
  if (stat.kind === expectedKind) {
    return stat;
  }
  throw new StorageError("bad_request", `invalid trash id: ${id}`, { details: { id } });
}

/**
 * Moves a leaf back to `target` (default: its original path), creating
 * missing parents, then removes the layout folders that leaves empty. The
 * move refuses an occupied target (`overwrite: false`), so a restore never
 * replaces what is there now: it fails with `conflict`.
 */
async function restoreLeaf(
  storage: Storage,
  trashRoot: string,
  id: string,
  target: string | undefined,
): Promise<TrashRestoreResult> {
  const leafPath = trashLeafPath(trashRoot, id);
  const parsed = parseMoveTrashLeaf(trashRoot, leafPath);
  if (parsed === null) {
    throw new StorageError("bad_request", `invalid trash id: ${id}`, { details: { id } });
  }
  await statLeaf(storage, id, leafPath, parsed.kind);
  const resolvedTarget = normalizePath(target ?? parsed.originalPath);
  if (resolvedTarget === trashRoot || isUnderPath(trashRoot, resolvedTarget)) {
    throw new StorageError("bad_request", "cannot restore into the trash folder", {
      details: { id, target: resolvedTarget },
    });
  }

  await storage.mkdir(parentPath(resolvedTarget), { parents: true });
  const restored = await storage.move(leafPath, resolvedTarget, { overwrite: false });
  await removeEmptyFolders(storage, trashRoot, parentPath(leafPath));
  return { ...restored, originalPath: parsed.originalPath };
}

/** Deletes a leaf for good, then the folders that leaves empty. A missing leaf is ignored. */
async function purgeLeaf(storage: Storage, trashRoot: string, id: string): Promise<void> {
  const leafPath = trashLeafPath(trashRoot, id);
  const parsed = parseMoveTrashLeaf(trashRoot, leafPath);
  if (parsed === null) {
    throw new StorageError("bad_request", `invalid trash id: ${id}`, { details: { id } });
  }
  try {
    const stat = await statLeaf(storage, id, leafPath, parsed.kind);
    if (stat.kind === "dir") {
      await storage.deleteDir(leafPath);
    } else {
      await storage.deleteFile(leafPath);
    }
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") {
      return;
    }
    throw error;
  }
  await removeEmptyFolders(storage, trashRoot, parentPath(leafPath));
}

/**
 * Builds a storage's Trash at `TRASH_PATH` purely on top of its own `list`,
 * `stat`, `move`, `mkdir`, `deleteFile`, `deleteDir` and `deleteEmptyDir`,
 * in fdrive's layout (`./recycle-folder.ts`).
 */
export function createRecycleFolderTrash(options: CreateRecycleFolderTrashOptions): TrashProvider {
  const { storage, clock, limit = DEFAULT_LIMIT } = options;
  const trashRoot = TRASH_PATH;

  return {
    put(path) {
      return moveIntoTrash(storage, path, clock());
    },
    list(listOptions) {
      return walk(storage, trashRoot, {
        limit: listOptions?.limit ?? limit,
        prune: listOptions?.prune === true,
        signal: listOptions?.signal,
      });
    },
    restore(id, restoreOptions) {
      return restoreLeaf(storage, trashRoot, id, restoreOptions?.target);
    },
    purge(id) {
      return purgeLeaf(storage, trashRoot, id);
    },
  };
}
