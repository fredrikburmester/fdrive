import { splitSegments } from "@fdrive/core";
import { originQuery } from "@/lib/files/path-url";

function encodeSegments(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

/** The editor-route URL for `path`, e.g. "/edit" or "/edit/a/b%20c", remembering `from` like
 * `viewHref` does. */
export function editHref(path: string, from?: string | null): string {
  const segments = splitSegments(path);
  const base = segments.length === 0 ? "/edit" : `/edit/${encodeSegments(segments)}`;
  return `${base}${originQuery(path, from)}`;
}
