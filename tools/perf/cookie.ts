/**
 * Extracts the `name=value` pair from a `Set-Cookie` header value, dropping
 * attributes like `Path`, `HttpOnly`, `SameSite`, and `Max-Age`. Returns
 * `undefined` when `setCookieHeader` is `null` (no cookie was set). Pure.
 */
export function extractCookiePair(setCookieHeader: string | null): string | undefined {
  if (setCookieHeader === null) {
    return undefined;
  }
  const firstSegment = setCookieHeader.split(";")[0];
  return firstSegment?.trim();
}
