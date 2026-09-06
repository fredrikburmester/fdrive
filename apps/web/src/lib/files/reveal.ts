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
