import { readJson, type StorageLike, writeJson } from "./deps";

/** sessionStorage key for the search panel's "Images" mode preference. */
export const IMAGE_MODE_STORAGE_KEY = "fdrive.search.imageMode";

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Reads the persisted "Images" search mode preference from `storage`
 * (`window.sessionStorage` in practice), falling back to `false`
 * (text search). Remembered only for the session, not across browser
 * restarts, since it is a transient toggle rather than a durable setting.
 */
export function readImageMode(storage: StorageLike): boolean {
  return readJson(storage, IMAGE_MODE_STORAGE_KEY, isBoolean, false);
}

/** Persists the "Images" search mode preference to `storage`. */
export function writeImageMode(storage: StorageLike, imageMode: boolean): void {
  writeJson(storage, IMAGE_MODE_STORAGE_KEY, imageMode);
}
