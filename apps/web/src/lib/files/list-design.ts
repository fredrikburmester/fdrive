import { readJson, type StorageLike, writeJson } from "./storage";

/**
 * Which file list this browser shows: the classic one, or the beta redesign (folders that open
 * in place, colored icons, a More button per row and checkboxes behind Select).
 */
export type ListDesign = "classic" | "beta";

/** localStorage key for the file list design. */
export const LIST_DESIGN_STORAGE_KEY = "fdrive.list.design";

export const DEFAULT_LIST_DESIGN: ListDesign = "classic";

export const LIST_DESIGNS: readonly ListDesign[] = ["classic", "beta"];

function isListDesign(value: unknown): value is ListDesign {
  return value === "classic" || value === "beta";
}

/** Reads the persisted file list design from `storage`, falling back to the classic list. */
export function readListDesign(storage: StorageLike): ListDesign {
  return readJson(storage, LIST_DESIGN_STORAGE_KEY, isListDesign, DEFAULT_LIST_DESIGN);
}

/** Persists `design` to `storage` under `fdrive.list.design`. */
export function writeListDesign(storage: StorageLike, design: ListDesign): void {
  writeJson(storage, LIST_DESIGN_STORAGE_KEY, design);
}
