import { readJson, type StorageLike, writeJson } from "./storage";

export const SHOW_THUMBNAILS_STORAGE_KEY = "fdrive.list.thumbnails";

export const DEFAULT_SHOW_THUMBNAILS = false;

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Reads whether to show image thumbnails in the list view, defaulting to false. */
export function readShowThumbnails(storage: StorageLike): boolean {
  return readJson(storage, SHOW_THUMBNAILS_STORAGE_KEY, isBoolean, DEFAULT_SHOW_THUMBNAILS);
}

/** Persists whether to show image thumbnails in the list view under `fdrive.list.thumbnails`. */
export function writeShowThumbnails(storage: StorageLike, show: boolean): void {
  writeJson(storage, SHOW_THUMBNAILS_STORAGE_KEY, show);
}
