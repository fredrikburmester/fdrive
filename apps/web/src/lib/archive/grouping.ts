import type { ArchiveEntry } from "@fdrive/contracts";

/** One folder's worth of archive entries, for `ArchivePreview`'s grouped table. */
export interface ArchiveEntryGroup {
  /** The containing folder's path within the archive; "" for the archive's root. */
  readonly folder: string;
  readonly entries: ArchiveEntry[];
}

/** The folder an archive entry's `path` lives directly under; "" at the root. */
export function archiveEntryFolder(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
}

/**
 * True when `entry.path` (case-insensitively) contains `query`. An empty or
 * whitespace-only `query` matches every entry.
 */
export function matchesArchiveSearch(entry: ArchiveEntry, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return true;
  }
  return entry.path.toLowerCase().includes(trimmed);
}

/** Every entry in `entries` whose path matches `query` (see `matchesArchiveSearch`). */
export function filterArchiveEntries(
  entries: readonly ArchiveEntry[],
  query: string,
): ArchiveEntry[] {
  return entries.filter((entry) => matchesArchiveSearch(entry, query));
}

/**
 * Groups `entries` by their containing folder (`archiveEntryFolder`),
 * preserving each group's own entry order, and orders the groups
 * themselves by folder path (the root, `""`, always sorts first). Entries
 * are assumed already sorted by path within a group, which is how the API
 * returns them.
 */
export function groupArchiveEntries(entries: readonly ArchiveEntry[]): ArchiveEntryGroup[] {
  const byFolder = new Map<string, ArchiveEntry[]>();
  for (const entry of entries) {
    const folder = archiveEntryFolder(entry.path);
    const existing = byFolder.get(folder);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      byFolder.set(folder, [entry]);
    }
  }

  return [...byFolder.entries()]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === "") return -1;
      if (b === "") return 1;
      return a < b ? -1 : 1;
    })
    .map(([folder, groupEntries]) => ({ folder, entries: groupEntries }));
}
