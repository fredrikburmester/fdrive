import { isUnderPath, StorageError, type StorageProvider } from "@fdrive/core";

/**
 * Moves or copies `path` to `target` for REST and MCP. Storage refuses a
 * taken target itself (`conflict`), so nothing is checked first: a check
 * would cost a stat, race the write, and on a disk that ignores case call a
 * case-only rename a conflict.
 */
export async function relocatePath(
  storage: StorageProvider,
  operation: "move" | "copy",
  path: string,
  target: string,
): Promise<void> {
  if (isUnderPath(path, target)) {
    throw new StorageError("bad_request", `cannot ${operation} a path into its own descendant`);
  }
  if (path === target) return;
  await storage[operation](path, target);
}
