import { AsyncLocalStorage } from "node:async_hooks";
import type { ActivityFacts } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";

interface Receipt {
  readonly path: string;
  leaf?: string;
  /** A delete of the same path further out, by a caller wrapping this storage. */
  readonly outer: Receipt | undefined;
}
const receipts = new AsyncLocalStorage<Receipt>();
/** The move-to-trash wrapper supplies its actual destination through the active operation. */
export function captureRecycleReceipt(path: string, leaf: string) {
  for (let receipt = receipts.getStore(); receipt !== undefined; receipt = receipt.outer)
    if (receipt.path === path) receipt.leaf = leaf;
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
  const receipt: Receipt = { path, outer: receipts.getStore() };
  await receipts.run(receipt, () =>
    kind === "dir" ? storage.deleteDir(path) : storage.deleteFile(path),
  );
  return receipt.leaf ? { path, kind, trashLeaf: receipt.leaf } : { path, kind };
}
