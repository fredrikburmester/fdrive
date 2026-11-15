import { RESERVED_FOLDER_NAMES, RESERVED_FOLDERS, type Scope, toFsPath } from "@fdrive/core";
import { INDEX_ROOT_ID, type IndexExclusion, type ScopePrefix } from "@fdrive/db";
import { SHARED_WITH_ME } from "@fdrive/local";

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

/** `scopes` as the index queries take them: prefixes in the files folder's root. */
export function indexPrefixes(scopes: readonly Scope[]): ScopePrefix[] {
  return scopes.map((scope) => ({ rootId: INDEX_ROOT_ID, fsPrefix: scope.fsPrefix }));
}

/**
 * fdrive's own folders (`isReservedPath`) as the index keeps them, for a
 * query over `scopes` to leave out before its limit: the folders
 * `RESERVED_FOLDERS` names and the home's own `Shared with me` (a reserved
 * name, out of sight; `roundTripVirtualPath`), mapped through the same
 * scopes, and the folder names reserved wherever they lie.
 */
export function reservedExclusion(scopes: readonly Scope[]): IndexExclusion {
  const prefixes = [...RESERVED_FOLDERS, `/${SHARED_WITH_ME}`].flatMap((folder): ScopePrefix[] => {
    const fsPrefix = toFsPath(scopes, folder);
    return fsPrefix === null ? [] : [{ rootId: INDEX_ROOT_ID, fsPrefix }];
  });
  return { prefixes, names: RESERVED_FOLDER_NAMES };
}
