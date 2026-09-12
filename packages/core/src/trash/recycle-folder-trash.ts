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
  type ParsedTrashLeaf,
  parseMoveTrashLeaf,
  parseTrashLeaf,
  type RecycleFolderLayout,
  trashLeafPath,
} from "./recycle-folder.ts";

/** Directory visits are bounded on top of the entry limit, matching the spec's default. */
const MAX_DIR_VISITS = 10000;
const DEFAULT_LIMIT = 10000;

export interface CreateRecycleFolderTrashOptions {
  readonly storage: StorageProvider;
  readonly trashPath: string;
  readonly limit?: number;
  /** Native providers use file leaves; the move wrapper uses its versioned namespace. */
  readonly layout?: RecycleFolderLayout;
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

type ParsedLeaf = ParsedTrashLeaf & { readonly kind: "file" | "dir" };

function parseLeaf(
  trashRoot: string,
  leafPath: string,
  layout: RecycleFolderLayout,
): ParsedLeaf | null {
  if (layout === "move") {
    return parseMoveTrashLeaf(trashRoot, leafPath);
  }
  const parsed = parseTrashLeaf(trashRoot, leafPath);
  return parsed === null ? null : { ...parsed, kind: "file" };
}

async function walk(
  storage: StorageProvider,
  trashRoot: string,
  layout: RecycleFolderLayout,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<TrashListing> {
  const entries: TrashEntry[] = [];
  let truncated = false;
  let dirVisits = 0;
  const moveRoot = moveTrashRootPath(trashRoot);
  const walkRoot = layout === "move" ? moveRoot : trashRoot;
  const queue: string[] = [walkRoot];

  for (const dir of queue) {
    checkAborted(signal);
    if (truncated) {
      break;
    }
    dirVisits += 1;
    if (dirVisits > MAX_DIR_VISITS) {
      truncated = true;
      break;
    }
    let children: FileEntry[];
    try {
      children = await storage.list(dir);
    } catch (error) {
      if (
        layout === "move" &&
        dir === walkRoot &&
        isStorageError(error) &&
        error.kind === "not_found"
      ) {
        return { entries: [], truncated: false };
      }
      throw error;
    }
    for (const child of children) {
      const parsed = parseLeaf(trashRoot, child.path, layout);
      if (parsed === null) {
        if (child.kind === "dir") {
          queue.push(child.path);
        }
        continue;
      }
      if (child.kind !== parsed.kind) {
        if (layout === "native" && child.kind === "dir") {
          queue.push(child.path);
        }
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
 * Ensures nothing already exists at `target` before `restoreLeaf` moves a
 * trash leaf there. The real drakkan/sftpgo:v2.7.5 container's move does
 * not raise a conflict for an occupied target: moving onto an existing file
 * silently overwrites it, and moving onto an existing directory fails with
 * a different error entirely (see `packages/sftpgo`'s fake, fixed to match
 * the verified container behaviour). `restore` must not silently destroy
 * whatever is already at `target`, so it checks first with `statFile`
 * instead of relying on `move` to report the conflict.
 *
 * `statFile` succeeding means a file is already there: conflict. A
 * directory is reported as `StorageError("bad_request")`, by convention
 * across every `StorageProvider` implementation (see
 * `packages/testkit/src/storage/memory-storage.ts`): also a conflict. `"not_found"` means
 * the target is free. Any other error (a permissions failure, an upstream
 * outage) is not this function's to interpret, so it propagates unchanged.
 */
async function requireTargetFree(
  storage: StorageProvider,
  id: string,
  target: string,
): Promise<void> {
  try {
    await storage.statFile(target);
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") {
      return;
    }
    if (!isStorageError(error) || error.kind !== "bad_request") {
      throw error;
    }
    // A directory sits at target; falls through to the conflict below.
  }
  throw new StorageError("conflict", `something already exists at ${target}`, {
    details: { id, target },
  });
}

async function restoreLeaf(
  storage: StorageProvider,
  trashRoot: string,
  layout: RecycleFolderLayout,
  id: string,
  target: string | undefined,
): Promise<TrashRestoreResult> {
  const leafPath = trashLeafPath(trashRoot, id);
  const parsed = parseLeaf(trashRoot, leafPath, layout);
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

  await requireTargetFree(storage, id, resolvedTarget);

  await storage.mkdir(parentPath(resolvedTarget), { parents: true });
  await storage.move(leafPath, resolvedTarget);

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

async function purgeLeaves(
  storage: StorageProvider,
  trashRoot: string,
  layout: RecycleFolderLayout,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    const leafPath = trashLeafPath(trashRoot, id);
    try {
      const parsed = parseLeaf(trashRoot, leafPath, layout);
      if (parsed === null) {
        throw new StorageError("bad_request", `invalid trash id: ${id}`, { details: { id } });
      }
      const stat = await statLeaf(storage, id, leafPath, parsed.kind);
      if (stat.kind === "dir") {
        await storage.deleteDir(leafPath);
      } else {
        await storage.deleteFile(leafPath);
      }
    } catch (error) {
      if (isStorageError(error) && error.kind === "not_found") {
        continue;
      }
      throw error;
    }
  }
}

async function emptyTrash(storage: StorageProvider, trashRoot: string): Promise<void> {
  const children = await storage.list(trashRoot);
  for (const child of children) {
    if (child.kind === "dir") {
      await storage.deleteDir(child.path);
    } else {
      await storage.deleteFile(child.path);
    }
  }
}

/**
 * Builds a `TrashProvider` purely on top of a `StorageProvider`'s own
 * `list`, `stat`, `move`, `mkdir`, `deleteFile`, and `deleteDir`, using the recycle
 * folder layout described in `./recycle-folder.ts`.
 */
export function createRecycleFolderTrash(options: CreateRecycleFolderTrashOptions): TrashProvider {
  const { storage, limit = DEFAULT_LIMIT, layout = "native" } = options;
  const trashRoot = normalizePath(options.trashPath);

  return {
    list(listOptions) {
      return walk(storage, trashRoot, layout, listOptions?.limit ?? limit, listOptions?.signal);
    },
    restore(id, restoreOptions) {
      return restoreLeaf(storage, trashRoot, layout, id, restoreOptions?.target);
    },
    purge(ids) {
      return purgeLeaves(storage, trashRoot, layout, ids);
    },
    empty() {
      return emptyTrash(storage, trashRoot);
    },
  };
}
