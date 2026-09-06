import { readJson, type StorageLike, writeJson } from "./storage";

/**
 * The pure result of laying out a virtualized grid's tiles: how many fit
 * per row, and the fixed pixel step (a tile's width plus the gap after it)
 * from one column's start to the next.
 */
export interface GridLayout {
  readonly columns: number;
  readonly tileStride: number;
}

/**
 * Computes how many `tileWidth`-wide tiles, separated by `gap`, fit across
 * `containerWidth`. Always returns at least one column, so a zero or not-
 * yet-measured width never collapses the grid to nothing: `columns` fits
 * `n` tiles when `n * tileWidth + (n - 1) * gap <= containerWidth`, which
 * rearranges to `n <= (containerWidth + gap) / (tileWidth + gap)`.
 */
export function computeGridLayout(
  containerWidth: number,
  tileWidth: number,
  gap: number,
): GridLayout {
  const tileStride = tileWidth + gap;
  if (tileStride <= 0) {
    return { columns: 1, tileStride };
  }
  const columns = Math.max(1, Math.floor((containerWidth + gap) / tileStride));
  return { columns, tileStride };
}

/** Where the grid's last measured container width is persisted, so a fresh
 * mount can seed its column count before its own first measurement. */
export const GRID_WIDTH_STORAGE_KEY = "fdrive.gridWidth";

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Reads the grid's last known container width from `storage`, in pixels.
 * Returns `0` ("unknown") when nothing usable is stored, so a cold start
 * (no prior session) is distinguishable from a genuinely narrow container.
 */
export function readGridWidth(storage: StorageLike): number {
  return readJson(storage, GRID_WIDTH_STORAGE_KEY, isPositiveNumber, 0);
}

/** Persists `width` as the grid's last known container width. */
export function writeGridWidth(storage: StorageLike, width: number): void {
  writeJson(storage, GRID_WIDTH_STORAGE_KEY, width);
}
