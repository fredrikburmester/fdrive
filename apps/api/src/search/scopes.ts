import { RESERVED_FOLDER_NAMES, reservedFolders, type Scope, toFsPath } from "@fdrive/core";
import type { IndexExclusion, IndexQueries, ScopePrefix } from "@fdrive/db";

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

/**
 * `queries` with `rootIdsByName` kept in memory once it names every root in
 * `names`. A root's id never changes once the indexer created its row, and
 * no root is ever deleted, so only a root not created yet is asked for
 * again.
 */
export function withCachedRootIds<T extends Pick<IndexQueries, "rootIdsByName">>(
  queries: T,
  names: Iterable<string>,
): T {
  const wanted = [...names];
  let known: Record<string, number> | undefined;
  return {
    ...queries,
    async rootIdsByName() {
      if (known !== undefined) return known;
      const ids = await queries.rootIdsByName();
      if (wanted.every((name) => ids[name] !== undefined)) known = ids;
      return ids;
    },
  };
}
