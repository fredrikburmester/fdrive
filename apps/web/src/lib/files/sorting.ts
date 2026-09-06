import type { FsEntry } from "@fdrive/contracts";
import { type FileEntry, type SortDirection, type SortKey, sortEntries } from "@fdrive/core";
import { readJson, type StorageLike, writeJson } from "./storage";

export interface SortSpec {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

export const DEFAULT_SORT_SPEC: SortSpec = { key: "name", direction: "asc" };

export const SORT_STORAGE_KEY = "fdrive.sort";

const SORT_KEYS: readonly SortKey[] = ["name", "size", "modifiedAt", "ext"];
const SORT_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

function isSortSpec(value: unknown): value is SortSpec {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const key = (value as Record<string, unknown>).key;
  const direction = (value as Record<string, unknown>).direction;
  return (
    typeof key === "string" &&
    (SORT_KEYS as readonly string[]).includes(key) &&
    typeof direction === "string" &&
    (SORT_DIRECTIONS as readonly string[]).includes(direction)
  );
}

/** Reads the persisted sort spec from `storage`, falling back to name/asc. */
export function readSortSpec(storage: StorageLike): SortSpec {
  return readJson(storage, SORT_STORAGE_KEY, isSortSpec, DEFAULT_SORT_SPEC);
}

/** Persists `spec` to `storage` under the shared `fdrive.sort` key. */
export function writeSortSpec(storage: StorageLike, spec: SortSpec): void {
  writeJson(storage, SORT_STORAGE_KEY, spec);
}

/** Flips `spec`'s direction, keeping its key. */
export function toggleSortDirection(spec: SortSpec): SortSpec {
  return { key: spec.key, direction: spec.direction === "asc" ? "desc" : "asc" };
}

/**
 * Adapts an API `FsEntry` (string `modifiedAt`, includes `mime`) to core's
 * `FileEntry` (Date `modifiedAt`) so `@fdrive/core`'s `sortEntries` can
 * compare it. `kind` and `ext` line up exactly between the two shapes.
 */
function toFileEntry(entry: FsEntry): FileEntry {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    modifiedAt: new Date(entry.modifiedAt),
    ext: entry.ext,
  };
}

/**
 * Sorts `entries` per `spec`, always placing directories before files
 * regardless of the chosen key or direction (Finder-style). `entries` is
 * the API's `FsEntry` shape; sorting is delegated to `@fdrive/core` via a
 * lightweight `Date` adapter, then the original entries are returned in
 * the resulting order (matched by path, which is unique per listing).
 */
export function sortListing(entries: readonly FsEntry[], spec: SortSpec): FsEntry[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const sorted = sortEntries(entries.map(toFileEntry), {
    key: spec.key,
    direction: spec.direction,
    foldersFirst: true,
  });
  return sorted.flatMap((entry) => {
    const original = byPath.get(entry.path);
    return original === undefined ? [] : [original];
  });
}
