/**
 * Archive-format-neutral helpers shared by the zip and tar peek readers:
 * the shape of one listed entry, the display-only safety check for a raw
 * archive name, and sorting/bounding the final list. Everything here is
 * pure (no I/O), so it is exercised directly and completely by its tests.
 */

export type PeekEntryKind = "file" | "dir";

/** One entry as `peekArchive` reports it, before serialization to the API contract. */
export interface PeekEntry {
  readonly path: string;
  readonly kind: PeekEntryKind;
  readonly size: number;
  readonly modifiedAt: Date | null;
}

/**
 * True when `name` (an archive entry's raw, unvalidated name) contains a
 * `..` segment, or is rooted (a POSIX absolute path, or a Windows drive or
 * UNC-style root). Mirrors the escape checks `@fdrive/core`'s
 * `safeEntryPath` performs before extraction, but peek never extracts or
 * otherwise resolves the name against a real filesystem location: this
 * only changes how the entry is *displayed*, forcing `kind: "file"` even
 * when the raw name looks like a directory, since a name flagged here is
 * never trustworthy enough to treat as a real folder grouping.
 */
export function isUnsafeArchiveEntryName(name: string): boolean {
  if (name.length === 0) {
    return true;
  }
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return true;
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return true;
  }
  return normalized.split("/").some((segment) => segment === "..");
}

/**
 * The path shown for an archive entry: backslashes normalized to forward
 * slashes (archives built on Windows use them) and a single trailing slash
 * (how zip marks a directory entry) removed.
 */
export function displayArchiveEntryPath(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Builds one `PeekEntry` from a raw archive entry name, a directory hint
 * (a zip name's trailing slash, or a tar header's own type), its size, and
 * its modification time. `isUnsafeArchiveEntryName` overrides the
 * directory hint to "file" for a name this is never safe to treat as a
 * real folder.
 */
export function buildPeekEntry(
  rawName: string,
  isDirectoryHint: boolean,
  size: number,
  modifiedAt: Date | null,
): PeekEntry {
  const kind: PeekEntryKind =
    isDirectoryHint && !isUnsafeArchiveEntryName(rawName) ? "dir" : "file";
  return { path: displayArchiveEntryPath(rawName), kind, size, modifiedAt };
}

/** Orders two entries by their display path, ascending. */
export function comparePeekEntryPath(a: PeekEntry, b: PeekEntry): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

/** A new array of `entries`, sorted by `comparePeekEntryPath`. */
export function sortPeekEntries(entries: readonly PeekEntry[]): PeekEntry[] {
  return [...entries].sort(comparePeekEntryPath);
}

/**
 * Caps `entries` at `max` items, reporting whether the cap was hit.
 * Assumes `entries` is already sorted into the order the caller wants
 * displayed; the first `max` entries are kept.
 */
export function boundPeekEntries(
  entries: readonly PeekEntry[],
  max: number,
): { entries: PeekEntry[]; truncated: boolean } {
  if (entries.length <= max) {
    return { entries: [...entries], truncated: false };
  }
  return { entries: entries.slice(0, max), truncated: true };
}
