import { isStorageError, isUnderPath, StorageError, type StorageProvider } from "@fdrive/core";

/** Shared admission for REST and MCP. Provider support determines atomicity. */
export async function requireUnoccupiedTarget(
  storage: StorageProvider,
  target: string,
): Promise<void> {
  try {
    await storage.statFile(target);
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") return;
    if (!isStorageError(error) || error.kind !== "bad_request") throw error;
  }
  throw new StorageError("conflict", `something already exists at ${target}`);
}

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
  await requireUnoccupiedTarget(storage, target);
  await storage[operation](path, target, { overwrite: false });
}
