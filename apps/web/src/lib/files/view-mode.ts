import { readJson, type StorageLike, writeJson } from "./storage";

export type ViewMode = "list" | "grid" | "tree";

export const VIEW_MODE_STORAGE_KEY = "fdrive.view";

/** The tree: a list whose folders open in place, so it is what a folder shows until set. */
export const DEFAULT_VIEW_MODE: ViewMode = "tree";

function isViewMode(value: unknown): value is ViewMode {
  return value === "list" || value === "grid" || value === "tree";
}

/** Reads the persisted view mode from `storage`, falling back to the tree. */
export function readViewMode(storage: StorageLike): ViewMode {
  return readJson(storage, VIEW_MODE_STORAGE_KEY, isViewMode, DEFAULT_VIEW_MODE);
}

/** Persists `mode` to `storage` under the shared `fdrive.view` key. */
export function writeViewMode(storage: StorageLike, mode: ViewMode): void {
  writeJson(storage, VIEW_MODE_STORAGE_KEY, mode);
}
