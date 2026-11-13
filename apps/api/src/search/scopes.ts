import { type Scope, toFsPath } from "@fdrive/core";
import type { ScopePrefix } from "@fdrive/db";

/**
 * Converts `mtimeNs` (nanoseconds since epoch, as the indexer stores it) to
 * a `Date`, truncating to millisecond precision.
 */
export function dateFromMtimeNs(mtimeNs: bigint): Date {
  return new Date(Number(mtimeNs / 1_000_000n));
}

/**
 * Converts a `Scope`-style fs prefix or path ("/" or "/alice/photos") into
 * the root-relative shape `idx.files.path` is stored as ("" or
 * "alice/photos"), matching `@fdrive/db`'s `toScopeClauses`.
 */
export function toIndexRelativePath(fsPath: string): string {
  return fsPath === "/" ? "" : fsPath.replace(/^\/+/, "");
}

/**
 * The login's Trash folder where the index keeps it: `trashPath` mapped
 * through the same scopes the search runs over, for the queries to leave out
 * before their limit. Empty without a Trash, or when no indexed root holds it.
 */
export function trashExclusion(
  scopes: readonly Scope[],
  trashPath: string | null,
  rootIds: Readonly<Record<string, number>>,
): ScopePrefix[] {
  if (trashPath === null) {
    return [];
  }
  const located = toFsPath(scopes, trashPath);
  const rootId = located === null ? undefined : rootIds[located.rootName];
  return located === null || rootId === undefined ? [] : [{ rootId, fsPrefix: located.fsPath }];
}
