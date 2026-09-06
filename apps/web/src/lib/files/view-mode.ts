import { readJson, type StorageLike, writeJson } from "./storage";

export type ViewMode = "list" | "grid";

export const VIEW_MODE_STORAGE_KEY = "fdrive.view";

export const DEFAULT_VIEW_MODE: ViewMode = "list";

function isViewMode(value: unknown): value is ViewMode {
  return value === "list" || value === "grid";
}

/** Reads the persisted view mode from `storage`, falling back to "list". */
export function readViewMode(storage: StorageLike): ViewMode {
  return readJson(storage, VIEW_MODE_STORAGE_KEY, isViewMode, DEFAULT_VIEW_MODE);
}

/** Persists `mode` to `storage` under the shared `fdrive.view` key. */
export function writeViewMode(storage: StorageLike, mode: ViewMode): void {
  writeJson(storage, VIEW_MODE_STORAGE_KEY, mode);
}
