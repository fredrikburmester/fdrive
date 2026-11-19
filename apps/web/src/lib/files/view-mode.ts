import type { ListDesign } from "./list-design";
import { readJson, type StorageLike, writeJson } from "./storage";

export type ViewMode = "list" | "grid" | "tree";

export const VIEW_MODE_STORAGE_KEY = "fdrive.view";

export const DEFAULT_VIEW_MODE: ViewMode = "list";

/** What a folder shows until a view is set: the beta list opens folders in place, as a tree. */
export function defaultViewModeFor(design: ListDesign): ViewMode {
  return design === "beta" ? "tree" : DEFAULT_VIEW_MODE;
}

function isViewMode(value: unknown): value is ViewMode {
  return value === "list" || value === "grid" || value === "tree";
}

/** Reads the persisted view mode from `storage`, falling back to `fallback` (the list). */
export function readViewMode(storage: StorageLike, fallback = DEFAULT_VIEW_MODE): ViewMode {
  return readJson(storage, VIEW_MODE_STORAGE_KEY, isViewMode, fallback);
}

/** Persists `mode` to `storage` under the shared `fdrive.view` key. */
export function writeViewMode(storage: StorageLike, mode: ViewMode): void {
  writeJson(storage, VIEW_MODE_STORAGE_KEY, mode);
}
