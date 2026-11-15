import type { FsEntry } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { splitNameForSelection } from "./naming";

/** How a batch rename builds each new name. */
export type BatchRenameRule =
  | { readonly mode: "replace"; readonly find: string; readonly replace: string }
  | { readonly mode: "number"; readonly base: string };

export interface BatchRenameRow {
  readonly path: string;
  readonly name: string;
  readonly newName: string;
  /** Whether the new name is already taken in the folder or given to another row. */
  readonly collides: boolean;
}

export interface BatchRenamePlan {
  readonly rows: readonly BatchRenameRow[];
  /** The rows whose name changes, in order: what Rename sends. */
  readonly changes: readonly BatchRenameRow[];
  /** Something changes and no new name collides. */
  readonly ready: boolean;
}

/**
 * The name `rule` gives the `index`-th (0-based) entry. "replace" swaps every
 * case-sensitive match of `find`; "number" makes `base 1`, `base 2`, ... and
 * keeps a file's extension. A rule with nothing typed yet keeps the name.
 */
export function batchRenameName(entry: FsEntry, index: number, rule: BatchRenameRule): string {
  if (rule.mode === "replace") {
    return rule.find === "" ? entry.name : entry.name.replaceAll(rule.find, rule.replace);
  }
  const base = rule.base.trim();
  if (base === "") return entry.name;
  const ext = entry.kind === "dir" ? "" : splitNameForSelection(entry.name).ext;
  return `${base} ${index + 1}${ext}`;
}

/**
 * Plans renaming `entries` (in listing order) by `rule`. `siblings` is every
 * entry the listing shows, so a new name that matches one already in its
 * folder collides, as does a name two rows would both get.
 */
export function planBatchRename(
  entries: readonly FsEntry[],
  rule: BatchRenameRule,
  siblings: readonly FsEntry[],
): BatchRenamePlan {
  const slot = (path: string, name: string) => `${parentPath(path)}\u0000${name}`;
  const taken = new Set(siblings.map((entry) => slot(entry.path, entry.name)));
  const named = entries.map((entry, index) => ({
    path: entry.path,
    name: entry.name,
    newName: batchRenameName(entry, index, rule),
  }));
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const row of named) {
    const key = slot(row.path, row.newName);
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  const rows = named.map((row) => {
    const key = slot(row.path, row.newName);
    const collides = row.newName !== row.name && (taken.has(key) || repeated.has(key));
    return { ...row, collides };
  });
  const changes = rows.filter((row) => row.newName !== row.name);
  return { rows, changes, ready: changes.length > 0 && rows.every((row) => !row.collides) };
}
