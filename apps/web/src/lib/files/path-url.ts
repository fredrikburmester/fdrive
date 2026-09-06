import { normalizePath, splitSegments } from "@fdrive/core";

export interface BreadcrumbEntry {
  readonly name: string;
  readonly path: string;
  readonly href: string;
}

function encodeSegments(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

/** The browse-route URL for `path`, e.g. "/files" or "/files/a/b%20c". */
export function pathToHref(path: string): string {
  const segments = splitSegments(path);
  return segments.length === 0 ? "/files" : `/files/${encodeSegments(segments)}`;
}

/** The preview-route URL for `path`, e.g. "/view" or "/view/a/b%20c". */
export function viewHref(path: string): string {
  const segments = splitSegments(path);
  return segments.length === 0 ? "/view" : `/view/${encodeSegments(segments)}`;
}

/**
 * Decodes a percent-encoded segment, falling back to the raw segment when
 * it is not valid percent-encoding rather than throwing.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Turns the route's catch-all `segments` (as Next.js hands them: an array
 * of raw, still percent-encoded path segments, or `undefined` at the root)
 * into a normalized virtual path.
 */
export function segmentsToPath(segments: readonly string[] | undefined): string {
  if (segments === undefined || segments.length === 0) {
    return "/";
  }
  return normalizePath(segments.map(decodeSegment).join("/"));
}

/**
 * Builds the breadcrumb trail for `path`: "Home" for the root, followed by
 * one entry per segment, each linking to `pathToHref` of its own path.
 */
export function buildBreadcrumbs(path: string): BreadcrumbEntry[] {
  const segments = splitSegments(path);
  const crumbs: BreadcrumbEntry[] = [{ name: "Home", path: "/", href: pathToHref("/") }];

  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    crumbs.push({ name: segment, path: current, href: pathToHref(current) });
  }

  return crumbs;
}
