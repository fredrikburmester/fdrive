import { readJson, type StorageLike, writeJson } from "./deps";

/** localStorage key for the recently-opened list, shared with the search panel's "Recent" section. */
export const RECENT_STORAGE_KEY = "fdrive.recent";

/** At most this many recently-opened paths are kept, newest first. */
export const MAX_RECENT_ITEMS = 8;

/** One recently-opened file or folder, as shown in the search panel's "Recent" section. */
export interface RecentItem {
  readonly path: string;
  readonly name: string;
  readonly openedAt: string;
}

function isRecentItem(value: unknown): value is RecentItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.openedAt === "string"
  );
}

function isRecentItemArray(value: unknown): value is RecentItem[] {
  return Array.isArray(value) && value.every(isRecentItem);
}

/**
 * Reads the persisted "recently opened" list from `storage`, newest first,
 * capped at `MAX_RECENT_ITEMS`. Returns `[]` for anything unreadable or
 * malformed, never throws.
 */
export function readRecent(storage: StorageLike): RecentItem[] {
  return readJson(storage, RECENT_STORAGE_KEY, isRecentItemArray, []).slice(0, MAX_RECENT_ITEMS);
}

/**
 * Records that `item` was just opened: moves it to the front of the list
 * (removing any earlier entry for the same path), persists the result
 * capped at `MAX_RECENT_ITEMS`, and returns the updated list.
 */
export function pushRecent(storage: StorageLike, item: RecentItem): RecentItem[] {
  const withoutDuplicate = readRecent(storage).filter((existing) => existing.path !== item.path);
  const updated = [item, ...withoutDuplicate].slice(0, MAX_RECENT_ITEMS);
  writeJson(storage, RECENT_STORAGE_KEY, updated);
  return updated;
}
