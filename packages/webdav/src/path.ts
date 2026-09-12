import { WebdavError } from "./errors.js";

/**
 * Validates that a provider path is usable: it must start with "/", must
 * not contain a NUL byte and must not carry "." or ".." segments. The URL
 * parser resolves dot segments (encoded or not) when the request URL is
 * built, so a ".." could otherwise climb out of the endpoint's prefix. The
 * storage adapter normalizes paths before calling the client; this is the
 * last line of defence, not a normalizer.
 */
export function assertValidPath(path: string): void {
  const dotted = segmentsOf(path).some((segment) => segment === "." || segment === "..");
  if (!path.startsWith("/") || path.includes("\0") || dotted) {
    throw new WebdavError(
      `Invalid WebDAV path: ${JSON.stringify(path)}`,
      "bad_request",
      null,
      null,
    );
  }
}

/** Splits a path into its non-empty segments. `[]` for the root. */
export function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Percent-encodes every segment of a provider path for use in a request
 * URL. A literal `%41` in a file name becomes `%2541`, so the server sees
 * the same name fdrive lists. The root encodes to "" so it can be joined
 * under the endpoint's own path prefix.
 */
export function encodePath(path: string): string {
  return segmentsOf(path).map(encodeURIComponent).join("/");
}

/** The parent of a provider path; "/" for the root and for top-level entries. */
export function parentOf(path: string): string {
  const segments = segmentsOf(path);
  return segments.length <= 1 ? "/" : `/${segments.slice(0, -1).join("/")}`;
}

/** The final segment of a provider path; "" for the root. */
export function baseNameOf(path: string): string {
  return segmentsOf(path).at(-1) ?? "";
}

/** True when `child` equals `parent` or is nested below it. */
export function isWithin(parent: string, child: string): boolean {
  return parent === "/" || child === parent || child.startsWith(`${parent}/`);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A server that sends an unencoded "%" keeps its raw segment.
    return segment;
  }
}

/**
 * The endpoint's own path prefix, always with a trailing slash:
 * "https://host/dav" and "https://host/dav/" both give "/dav/".
 */
export function endpointPrefix(baseUrl: string): string {
  const pathname = new URL(baseUrl).pathname;
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

/**
 * Resolves an `href` from a multistatus body to a provider path, or `null`
 * when it must be ignored: a different origin, a path outside the
 * endpoint's prefix, or an unparsable reference. Segments are
 * percent-decoded one at a time so an encoded slash never splits a name.
 * Dot segments, encoded or not, are resolved by the URL parser before the
 * prefix check, so `..` can only ever point outside the endpoint. A
 * trailing slash (the collection marker) is dropped.
 */
export function resolveHref(href: string, baseUrl: string): string | null {
  const base = new URL(baseUrl);
  let resolved: URL;
  try {
    resolved = new URL(href, base);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) return null;
  const prefix = endpointPrefix(baseUrl);
  const pathname = resolved.pathname;
  if (`${pathname}/` === prefix) return "/";
  if (!pathname.startsWith(prefix)) return null;
  const segments = segmentsOf(pathname.slice(prefix.length)).map(decodeSegment);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
