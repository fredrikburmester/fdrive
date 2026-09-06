import { splitSegments } from "@fdrive/core";

function encodeSegments(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

/** The editor-route URL for `path`, e.g. "/edit" or "/edit/a/b%20c". */
export function editHref(path: string): string {
  const segments = splitSegments(path);
  return segments.length === 0 ? "/edit" : `/edit/${encodeSegments(segments)}`;
}
