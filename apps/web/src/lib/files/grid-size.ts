import { readJson, type StorageLike, writeJson } from "./storage";

/** How large grid tiles are, with their icons and thumbnails. */
export type GridSize = "small" | "medium" | "large";

/** localStorage key for the grid size preference. */
export const GRID_SIZE_STORAGE_KEY = "fdrive.grid.size";

export const DEFAULT_GRID_SIZE: GridSize = "medium";

export const GRID_SIZES: readonly GridSize[] = ["small", "medium", "large"];

function isGridSize(value: unknown): value is GridSize {
  return value === "small" || value === "medium" || value === "large";
}

/** Reads the persisted grid size from `storage`, falling back to "medium". */
export function readGridSize(storage: StorageLike): GridSize {
  return readJson(storage, GRID_SIZE_STORAGE_KEY, isGridSize, DEFAULT_GRID_SIZE);
}

/** Persists `size` to `storage` under the shared `fdrive.grid.size` key. */
export function writeGridSize(storage: StorageLike, size: GridSize): void {
  writeJson(storage, GRID_SIZE_STORAGE_KEY, size);
}
