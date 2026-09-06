import { type HomeTemplate, type Scope, scopesFor } from "@fdrive/core";

/**
 * Resolves the scopes usable for index-backed features (search,
 * thumbnails): the identity's scopes from `homeTemplate`, restricted to
 * roots actually configured in `FDRIVE_INDEX_ROOTS`. Empty when the
 * username is not a safe path segment (an invalid identity) or when none of
 * the identity's scopes land on a configured root, both of which mean
 * "index-backed features are unavailable for this caller" rather than an
 * error.
 */
export function usableScopesFor(
  homeTemplate: HomeTemplate,
  indexRootNames: ReadonlySet<string>,
  username: string,
): Scope[] {
  let scopes: Scope[];
  try {
    scopes = scopesFor({ template: homeTemplate, username });
  } catch {
    return [];
  }
  return scopes.filter((scope) => indexRootNames.has(scope.rootName));
}

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
