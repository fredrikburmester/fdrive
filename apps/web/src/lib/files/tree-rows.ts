import type { FsEntry } from "@fdrive/contracts";
import type { SortSpec } from "./sorting";
import { sortListing } from "./sorting";

/** One row of the main browser's tree view: an entry at a given indent depth. */
export interface TreeRow {
  readonly entry: FsEntry;
  readonly depth: number;
}

/**
 * Flattens a folder's entries and any expanded descendants into a single
 * ordered, depth-annotated list for the tree view's virtualized rows. Every
 * level (including `rootEntries`) is sorted with `sortSpec`, folders first.
 * `childrenByPath` holds each expanded folder's already-fetched entries; an
 * expanded folder missing from it (not loaded yet) contributes no rows for
 * its children this render.
 */
export function flattenTree(
  rootEntries: readonly FsEntry[],
  expanded: ReadonlySet<string>,
  childrenByPath: ReadonlyMap<string, readonly FsEntry[]>,
  sortSpec: SortSpec,
): TreeRow[] {
  const rows: TreeRow[] = [];

  function visit(entries: readonly FsEntry[], depth: number): void {
    for (const entry of sortListing(entries, sortSpec)) {
      rows.push({ entry, depth });
      if (entry.kind === "dir" && expanded.has(entry.path)) {
        const children = childrenByPath.get(entry.path);
        if (children !== undefined) {
          visit(children, depth + 1);
        }
      }
    }
  }

  visit(rootEntries, 0);
  return rows;
}

/**
 * Every directory path that is expanded and reachable from `rootEntries`
 * given what is already known in `childrenByPath`: the paths whose listing
 * the tree view still needs to fetch (or re-fetch) to render fully. Grows
 * one level per render as `childrenByPath` fills in, converging once every
 * expanded folder's ancestors are all loaded.
 */
export function reachableExpandedDirs(
  rootEntries: readonly FsEntry[],
  expanded: ReadonlySet<string>,
  childrenByPath: ReadonlyMap<string, readonly FsEntry[]>,
): string[] {
  const result: string[] = [];

  function visit(entries: readonly FsEntry[]): void {
    for (const entry of entries) {
      if (entry.kind === "dir" && expanded.has(entry.path)) {
        result.push(entry.path);
        const children = childrenByPath.get(entry.path);
        if (children !== undefined) {
          visit(children);
        }
      }
    }
  }

  visit(rootEntries);
  return result;
}
