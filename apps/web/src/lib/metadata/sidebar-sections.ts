import { readJson, type StorageLike, writeJson } from "./deps";

/** The sidebar's collapsible sections, each with its own persisted
 * collapsed/expanded state. */
export type SidebarSectionKey = "favorites" | "recents" | "tags" | "features";

const STORAGE_KEY_PREFIX = "fdrive.sidebar.section.";

export const DEFAULT_SIDEBAR_SECTION_OPEN = true;

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Reads whether `section`'s `SidebarGroup` is expanded, defaulting to open. */
export function readSidebarSectionOpen(storage: StorageLike, section: SidebarSectionKey): boolean {
  return readJson(
    storage,
    `${STORAGE_KEY_PREFIX}${section}`,
    isBoolean,
    DEFAULT_SIDEBAR_SECTION_OPEN,
  );
}

/** Persists whether `section`'s `SidebarGroup` is expanded. */
export function writeSidebarSectionOpen(
  storage: StorageLike,
  section: SidebarSectionKey,
  open: boolean,
): void {
  writeJson(storage, `${STORAGE_KEY_PREFIX}${section}`, open);
}

/**
 * The three states a sidebar metadata section can be in: still loading (its
 * query has not resolved yet, so the section renders nothing rather than a
 * premature empty message), loaded with nothing to show (a muted one-line
 * placeholder), or loaded with items.
 */
export type SidebarSectionState = "loading" | "empty" | "content";

/** Classifies a section's query result for rendering: Favorites, Recents,
 * and Tags all always render once loaded (unlike the old behaviour of
 * disappearing entirely while empty), showing a muted placeholder line
 * instead of nothing. */
export function sidebarSectionState(items: readonly unknown[] | undefined): SidebarSectionState {
  if (items === undefined) {
    return "loading";
  }
  return items.length === 0 ? "empty" : "content";
}
