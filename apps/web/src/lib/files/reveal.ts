/**
 * Builds the URL for "reveal in folder": `parentHref` (a browse-route href,
 * e.g. from `pathToHref`) with a `select` query parameter naming the item
 * to select once that folder's listing loads. `parseSelectParam` is the
 * inverse, read by the browse page itself.
 */
export function revealTarget(parentHref: string, name: string): string {
  const separator = parentHref.includes("?") ? "&" : "?";
  return `${parentHref}${separator}select=${encodeURIComponent(name)}`;
}

/**
 * Reads the `select` search param (a bare item name, not a full path) from
 * a URL's search string, e.g. `"?select=readme.md"`, `"select=readme.md"`,
 * or `useSearchParams().toString()`. Returns `null` when absent or empty,
 * decoded otherwise.
 */
export function parseSelectParam(search: string): string | null {
  const params = new URLSearchParams(search);
  const value = params.get("select");
  return value === null || value.length === 0 ? null : value;
}

/**
 * Returns the index of `targetPath` within `entries`, or -1 if `targetPath`
 * is null or not found.
 */
export function findRevealIndex<T extends { path: string }>(
  entries: readonly T[],
  targetPath: string | null,
): number {
  if (targetPath === null) {
    return -1;
  }
  return entries.findIndex((entry) => entry.path === targetPath);
}

/**
 * Calculates the virtualizer row index in a multi-column grid given the item
 * index and column count. Returns -1 if `itemIndex` is negative.
 */
export function gridRowForIndex(itemIndex: number, columns: number): number {
  if (itemIndex < 0) {
    return -1;
  }
  return Math.floor(itemIndex / Math.max(columns, 1));
}

/**
 * Determines whether a reveal action should be triggered: when `targetPath`
 * is non-null, is present in `orderedPaths`, and is not already the last
 * revealed path.
 */
export function shouldPerformReveal(
  targetPath: string | null,
  orderedPaths: readonly string[],
  lastRevealed: string | null,
): boolean {
  return targetPath !== null && orderedPaths.includes(targetPath) && targetPath !== lastRevealed;
}

/**
 * Removes the `select` search param from `search` while preserving any other
 * query parameters. Returns the cleaned search string (with leading `?` if non-empty,
 * or empty string if no parameters remain).
 */
export function cleanupSelectParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("select");
  const remaining = params.toString();
  return remaining.length > 0 ? `?${remaining}` : "";
}

/** A request to scroll a specific entry into view, identified by unique token. */
export interface ScrollRequest {
  readonly path: string;
  readonly token: number;
}
