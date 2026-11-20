import { readJson, type StorageLike, writeJson } from "./storage";

/**
 * localStorage key for whether the details panel shows beside the listing. Not the earlier
 * `fdrive.inspector`: that key holds choices made while the panel started closed, so a browser
 * that saved "closed" there gets the open default once, and a close after that sticks.
 */
export const INSPECTOR_STORAGE_KEY = "fdrive.inspector.open";

/** The side panel starts open; a sheet never opens unasked (see `useInspectorOpen`). */
export const DEFAULT_INSPECTOR_OPEN = true;

/**
 * From this width up the details panel sits beside the listing; below it, it is a sheet. The
 * `Inspector` picks its layout at the same breakpoint.
 */
export const INSPECTOR_SIDE_PANEL_QUERY = "(min-width: 1024px)";

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Reads whether the side panel is open, defaulting to open. */
export function readInspectorOpen(storage: StorageLike): boolean {
  return readJson(storage, INSPECTOR_STORAGE_KEY, isBoolean, DEFAULT_INSPECTOR_OPEN);
}

/** Persists whether the side panel is open under `fdrive.inspector.open`. */
export function writeInspectorOpen(storage: StorageLike, open: boolean): void {
  writeJson(storage, INSPECTOR_STORAGE_KEY, open);
}
