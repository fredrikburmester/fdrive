import { readJson, type StorageLike, writeJson } from "./storage";

/** How tall list and tree rows are: the default spacing, or a tighter one that shows more rows. */
export type ListDensity = "comfortable" | "compact";

/** localStorage key for the list density preference. */
export const DENSITY_STORAGE_KEY = "fdrive.list.density";

export const DEFAULT_LIST_DENSITY: ListDensity = "comfortable";

export const LIST_DENSITIES: readonly ListDensity[] = ["comfortable", "compact"];

/** Row height in pixels for each density; "comfortable" is the list's original height. */
export const ROW_HEIGHTS: Record<ListDensity, number> = { comfortable: 36, compact: 28 };

/** Row height in pixels below `md`, where size and date move onto a second line under the
 * name; even "compact" keeps a 44px tap target. */
export const MOBILE_ROW_HEIGHTS: Record<ListDensity, number> = { comfortable: 56, compact: 44 };

/** The list row height for `density`, taller on phones (see `MOBILE_ROW_HEIGHTS`). */
export function listRowHeight(density: ListDensity, mobile: boolean): number {
  return (mobile ? MOBILE_ROW_HEIGHTS : ROW_HEIGHTS)[density];
}

function isListDensity(value: unknown): value is ListDensity {
  return value === "comfortable" || value === "compact";
}

/** Reads the persisted list density from `storage`, falling back to "comfortable". */
export function readListDensity(storage: StorageLike): ListDensity {
  return readJson(storage, DENSITY_STORAGE_KEY, isListDensity, DEFAULT_LIST_DENSITY);
}

/** Persists `density` to `storage` under the shared `fdrive.list.density` key. */
export function writeListDensity(storage: StorageLike, density: ListDensity): void {
  writeJson(storage, DENSITY_STORAGE_KEY, density);
}
