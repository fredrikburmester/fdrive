import type { FileEntry } from "../entries.ts";
import { makeEntry } from "../entries.ts";
import { isStorageError, StorageError } from "../errors.ts";
import { baseName, normalizePath, parentPath, relativeTo } from "../paths.ts";
import type {
  EntryStat,
  StorageProvider,
  TrashEntry,
  TrashListing,
  TrashProvider,
  TrashRestoreResult,
} from "../ports/storage.ts";
import {
  isUnderPath,
  moveTrashRootPath,
  parseMoveTrashLeaf,
  trashLeafPath,
} from "./recycle-folder.ts";

const DEFAULT_LIMIT = 10000;

export interface CreateRecycleFolderTrashOptions {
  readonly storage: StorageProvider;
  readonly trashPath: string;
  readonly limit?: number;
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
async function removeEmptyFolders(
  storage: StorageProvider,
  trashRoot: string,
  dir: string,
): Promise<void> {
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
  storage: StorageProvider,
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
  storage: StorageProvider,
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
  storage: StorageProvider,
  trashRoot: string,
  id: string,
  target: string | undefined,
): Promise<TrashRestoreResult> {
  const leafPath = trashLeafPath(trashRoot, id);
  const parsed = parseMoveTrashLeaf(trashRoot, leafPath);
  if (parsed === null) {
    throw new StorageError("bad_request", `invalid trash id: ${id}`, { details: { id } });
  }
  const leafStat = await statLeaf(storage, id, leafPath, parsed.kind);
  const resolvedTarget = normalizePath(target ?? parsed.originalPath);
  if (resolvedTarget === trashRoot || isUnderPath(trashRoot, resolvedTarget)) {
    throw new StorageError("bad_request", "cannot restore into the trash folder", {
      details: { id, target: resolvedTarget },
    });
  }

  await storage.mkdir(parentPath(resolvedTarget), { parents: true });
  await storage.move(leafPath, resolvedTarget, { overwrite: false });
  await removeEmptyFolders(storage, trashRoot, parentPath(leafPath));

  return {
    ...makeEntry(parentPath(resolvedTarget), {
      name: baseName(resolvedTarget),
      kind: leafStat.kind,
      size: leafStat.size,
      modifiedAt: leafStat.modifiedAt ?? new Date(0),
    }),
    originalPath: parsed.originalPath,
  };
}

/** Deletes a leaf for good, then the folders that leaves empty. A missing leaf is ignored. */
async function purgeLeaf(storage: StorageProvider, trashRoot: string, id: string): Promise<void> {
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
 * Builds a `TrashProvider` purely on top of a `StorageProvider`'s own
 * `list`, `stat`, `move`, `mkdir`, `deleteFile`, `deleteDir` and
 * `deleteEmptyDir`, reading the leaves `withMoveToTrash` writes (layout in
 * `./recycle-folder.ts`).
 */
export function createRecycleFolderTrash(options: CreateRecycleFolderTrashOptions): TrashProvider {
  const { storage, limit = DEFAULT_LIMIT } = options;
  const trashRoot = normalizePath(options.trashPath);

  return {
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
