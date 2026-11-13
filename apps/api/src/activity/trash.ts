import { AsyncLocalStorage } from "node:async_hooks";
import type { ActivityFacts } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";

const receipts = new AsyncLocalStorage<{ path: string; leaf?: string }>();
/** The move-to-trash wrapper supplies its actual destination through the active operation. */
export function captureRecycleReceipt(path: string, leaf: string) {
  const receipt = receipts.getStore();
  if (receipt?.path === path) receipt.leaf = leaf;
}
/**
 * Deletes `path` and reports the Trash leaf the move-to-trash wrapper chose
 * for it. Without that wrapper (no Trash, or a path already inside it) the
 * delete is permanent and no leaf is reported.
 */
export async function deleteWithActivityReceipt(
  storage: StorageProvider,
  path: string,
  kind: "file" | "dir",
): Promise<ActivityFacts> {
  const receipt: { path: string; leaf?: string } = { path };
  await receipts.run(receipt, () =>
    kind === "dir" ? storage.deleteDir(path) : storage.deleteFile(path),
  );
  return receipt.leaf ? { path, kind, trashLeaf: receipt.leaf } : { path, kind };
}
