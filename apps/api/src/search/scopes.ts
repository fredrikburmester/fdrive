import { RESERVED_FOLDER_NAMES, reservedFolders, type Scope, toFsPath } from "@fdrive/core";
import type { IndexExclusion, ScopePrefix } from "@fdrive/db";

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
 * fdrive's own folders (`isReservedPath`) as the index keeps them, for a
 * query over `scopes` to leave out before its limit: the folders
 * `reservedFolders` names, mapped through the same scopes, and the folder
 * names reserved wherever they lie. A folder no indexed root holds is left
 * out of the prefixes; there is nothing of it to find.
 */
export function reservedExclusion(
  scopes: readonly Scope[],
  trashPath: string | null,
  rootIds: Readonly<Record<string, number>>,
): IndexExclusion {
  const prefixes = reservedFolders(trashPath).flatMap((folder): ScopePrefix[] => {
    const located = toFsPath(scopes, folder);
    const rootId = located === null ? undefined : rootIds[located.rootName];
    return located === null || rootId === undefined ? [] : [{ rootId, fsPrefix: located.fsPath }];
  });
  return { prefixes, names: RESERVED_FOLDER_NAMES };
}
