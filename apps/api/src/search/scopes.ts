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
