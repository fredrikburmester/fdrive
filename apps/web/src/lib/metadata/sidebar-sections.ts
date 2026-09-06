import { readJson, type StorageLike, writeJson } from "./deps";

/** The sidebar's three metadata sections, each with its own persisted
 * collapsed/expanded state. */
export type SidebarSectionKey = "favorites" | "recents" | "tags";

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
