import { extensionOf, joinPath } from "./paths.js";

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly modifiedAt: Date;
  readonly ext: string;
}

/**
 * Builds a `FileEntry` under `parentPath`, filling in `path` (joined and
 * normalized) and `ext` (from the name; always "" for directories).
 */
export function makeEntry(
  parentPath: string,
  input: {
    readonly name: string;
    readonly kind: EntryKind;
    readonly size: number;
    readonly modifiedAt: Date;
  },
): FileEntry {
  return {
    name: input.name,
    path: joinPath(parentPath, input.name),
    kind: input.kind,
    size: input.size,
    modifiedAt: input.modifiedAt,
    ext: input.kind === "dir" ? "" : extensionOf(input.name),
  };
}

export type SortKey = "name" | "size" | "modifiedAt" | "ext";
export type SortDirection = "asc" | "desc";

export interface SortOptions {
  readonly key: SortKey;
  readonly direction: SortDirection;
  readonly foldersFirst?: boolean;
  readonly collator?: Intl.Collator;
}

/** Natural-order collator: numeric-aware, case-insensitive. */
const DEFAULT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareByKey(a: FileEntry, b: FileEntry, key: SortKey, collator: Intl.Collator): number {
  switch (key) {
    case "name":
      return collator.compare(a.name, b.name);
    case "ext":
      return collator.compare(a.ext, b.ext);
    case "size":
      return a.size - b.size;
    case "modifiedAt":
      return a.modifiedAt.getTime() - b.modifiedAt.getTime();
  }
}

/**
 * Sorts entries by `key`, stably, in natural order for names (numeric-aware,
 * case-insensitive by default). Returns a new array; `entries` is untouched.
 * With `foldersFirst`, directories sort before everything else regardless
 * of `key` or `direction`.
 */
export function sortEntries(entries: readonly FileEntry[], options: SortOptions): FileEntry[] {
  const { key, direction, foldersFirst = false, collator = DEFAULT_COLLATOR } = options;
  const sign = direction === "asc" ? 1 : -1;

  const indexed = entries.map((entry, index) => ({ entry, index }));

  indexed.sort((a, b) => {
    if (foldersFirst) {
      const aIsDir = a.entry.kind === "dir";
      const bIsDir = b.entry.kind === "dir";
      if (aIsDir !== bIsDir) {
        return aIsDir ? -1 : 1;
      }
    }
    const primary = compareByKey(a.entry, b.entry, key, collator) * sign;
    return primary !== 0 ? primary : a.index - b.index;
  });

  return indexed.map((item) => item.entry);
}
