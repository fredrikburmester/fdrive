import { AsyncLocalStorage } from "node:async_hooks";
import type { ActivityFacts } from "@fdrive/contracts";
import {
  isStorageError,
  parseMoveTrashLeaf,
  parseTrashLeaf,
  type StorageProvider,
} from "@fdrive/core";

export function activityTrashLeaf(root: string, leaf: string) {
  return parseMoveTrashLeaf(root, leaf) ?? parseTrashLeaf(root, leaf);
}

const receipts = new AsyncLocalStorage<{ path: string; leaf?: string }>();
/** The WebDAV move wrapper supplies its actual destination through the active operation. */
export function captureRecycleReceipt(path: string, leaf: string) {
  const receipt = receipts.getStore();
  if (receipt?.path === path) receipt.leaf = leaf;
}
async function leaves(
  storage: StorageProvider,
  trashRoot: string,
  path: string,
): Promise<Set<string> | null> {
  try {
    const entries = await storage.list(`${trashRoot}${path}`);
    if (entries.length > 1000) return null;
    return new Set(
      entries
        .map((entry) => entry.path)
        .filter((leaf) => parseTrashLeaf(trashRoot, leaf)?.originalPath === path),
    );
  } catch (error) {
    return isStorageError(error) && error.kind === "not_found" ? new Set() : null;
  }
}
/** Caller serializes deletes of this identity/path. No clock/basename guesses for SFTPGo. */
export async function deleteWithActivityReceipt(
  storage: StorageProvider,
  path: string,
  kind: "file" | "dir",
  trashRoot: string | null,
): Promise<ActivityFacts> {
  const before = trashRoot ? await leaves(storage, trashRoot, path) : null;
  const receipt: { path: string; leaf?: string } = { path };
  await receipts.run(receipt, () =>
    kind === "dir" ? storage.deleteDir(path) : storage.deleteFile(path),
  );
  if (receipt.leaf) return { path, kind, trashLeaf: receipt.leaf, trashStrategy: "fdrive_move" };
  if (trashRoot && before) {
    const after = await leaves(storage, trashRoot, path);
    const added = after ? [...after].filter((leaf) => !before.has(leaf)) : [];
    if (added.length === 1 && added[0])
      return { path, kind, trashLeaf: added[0], trashStrategy: "sftpgo_rule" };
  }
  return { path, kind };
}
