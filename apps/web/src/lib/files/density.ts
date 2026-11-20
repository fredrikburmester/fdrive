import { readJson, type StorageLike, writeJson } from "./storage";

/**
 * How tall list and tree rows are: "standard", the default; "comfortable", roomy rows with a
 * large icon or thumbnail; or "compact", the tightest rows, which show the most of a folder.
 */
export type ListDensity = "comfortable" | "standard" | "compact";

/**
 * localStorage key for the list density preference. It replaced `fdrive.list.density`, whose
 * "compact" meant what "standard" means now, so a choice saved under the old key is not read
 * and every browser starts from the default.
 */
export const DENSITY_STORAGE_KEY = "fdrive.list.rowDensity";

export const DEFAULT_LIST_DENSITY: ListDensity = "standard";

/** Every density, from the tallest rows to the shortest. */
export const LIST_DENSITIES: readonly ListDensity[] = ["comfortable", "standard", "compact"];

/** Row height in pixels for each density; "standard" is the list's original height. */
export const ROW_HEIGHTS: Record<ListDensity, number> = {
  comfortable: 64,
  standard: 36,
  compact: 30,
};

/** Row height in pixels below `md`, where size and date move onto a second line under the
 * name; "standard" is the phone list's original height, and even "compact" keeps a 44px tap
 * target. */
export const MOBILE_ROW_HEIGHTS: Record<ListDensity, number> = {
  comfortable: 68,
  standard: 56,
  compact: 48,
};

/** The list row height for `density`, taller on phones (see `MOBILE_ROW_HEIGHTS`). */
export function listRowHeight(density: ListDensity, mobile: boolean): number {
  return (mobile ? MOBILE_ROW_HEIGHTS : ROW_HEIGHTS)[density];
}

function isListDensity(value: unknown): value is ListDensity {
  return value === "comfortable" || value === "standard" || value === "compact";
}

/** Reads the persisted list density from `storage`, falling back to "standard". */
export function readListDensity(storage: StorageLike): ListDensity {
  return readJson(storage, DENSITY_STORAGE_KEY, isListDensity, DEFAULT_LIST_DENSITY);
}

/** Persists `density` to `storage` under the shared `fdrive.list.rowDensity` key. */
export function writeListDensity(storage: StorageLike, density: ListDensity): void {
  writeJson(storage, DENSITY_STORAGE_KEY, density);
}
