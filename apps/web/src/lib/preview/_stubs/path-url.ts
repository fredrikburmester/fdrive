/**
 * Stand-in for `src/lib/files/path-url.ts`, which another chunk builds in
 * parallel. Assumes the browser lives under `/browse/<segments>` (root at
 * `/browse`) and the preview route this chunk owns lives under
 * `/view/<segments>`. `deps.ts` re-exports this so the integration chunk
 * can repoint one import once the real module (and its real route names)
 * land.
 */

function toSegments(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
}

/** Decodes a URI component, returning it unchanged if it was not encoded. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The inverse of the route's `[...path]` segments: back to a normalized fs path. */
export function segmentsToPath(segments: readonly string[]): string {
  const decoded = segments.map(safeDecode);
  return decoded.length === 0 ? "/" : `/${decoded.join("/")}`;
}

/** The browser href for `path`. */
export function pathToHref(path: string): string {
  const segments = toSegments(path);
  return segments.length === 0 ? "/browse" : `/browse/${segments.join("/")}`;
}

/** The preview route href for `path`. */
export function viewHref(path: string): string {
  const segments = toSegments(path);
  return segments.length === 0 ? "/view" : `/view/${segments.join("/")}`;
}
