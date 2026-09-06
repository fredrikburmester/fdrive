import { readJson, type StorageLike, writeJson } from "./deps";

/**
 * What Enter does to the highlighted search result: open it directly
 * ("file"), or reveal its enclosing folder with it selected ("folder"). The
 * other action moves to Cmd/Ctrl+Enter.
 */
export type EnterAction = "file" | "folder";

/** localStorage key for the search panel's Enter-action preference. */
export const ENTER_ACTION_STORAGE_KEY = "fdrive.search.enterAction";

export const DEFAULT_ENTER_ACTION: EnterAction = "file";

function isEnterAction(value: unknown): value is EnterAction {
  return value === "file" || value === "folder";
}

/** Reads the persisted Enter-action preference from `storage`, falling back to "file". */
export function readEnterAction(storage: StorageLike): EnterAction {
  return readJson(storage, ENTER_ACTION_STORAGE_KEY, isEnterAction, DEFAULT_ENTER_ACTION);
}

/** Persists `action` to `storage` under the shared `fdrive.search.enterAction` key. */
export function writeEnterAction(storage: StorageLike, action: EnterAction): void {
  writeJson(storage, ENTER_ACTION_STORAGE_KEY, action);
}
