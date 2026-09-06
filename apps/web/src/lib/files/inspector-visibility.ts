import { readJson, type StorageLike, writeJson } from "./storage";

export const INSPECTOR_STORAGE_KEY = "fdrive.inspector";

export const DEFAULT_INSPECTOR_OPEN = false;

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Reads whether the inspector panel was open, defaulting to closed. */
export function readInspectorOpen(storage: StorageLike): boolean {
  return readJson(storage, INSPECTOR_STORAGE_KEY, isBoolean, DEFAULT_INSPECTOR_OPEN);
}

/** Persists whether the inspector panel is open under the shared `fdrive.inspector` key. */
export function writeInspectorOpen(storage: StorageLike, open: boolean): void {
  writeJson(storage, INSPECTOR_STORAGE_KEY, open);
}
