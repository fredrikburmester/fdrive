import { normalizePath, parentPath, splitSegments } from "@fdrive/core";

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

/** Whether `folder` is a folder above `path`, such as the root a tree row was opened from. */
function isAbove(folder: string, path: string): boolean {
  return folder === "/" ? path !== "/" : path.startsWith(`${folder}/`);
}

/**
 * The folder a file's routes return to: `from`, the folder its listing showed when it was opened
 * (a tree shows files of folders below it), or else the file's own folder.
 */
export function originFolder(path: string, from: string | null | undefined): string {
  return from != null && isAbove(from, path) ? from : parentPath(path);
}

/**
 * The `?from=` a file route carries to remember `from`, or "" when there is nothing to remember
 * because `from` is the file's own folder.
 */
export function originQuery(path: string, from: string | null | undefined): string {
  const folder = originFolder(path, from);
  return folder === parentPath(path) ? "" : `?from=${encodeURIComponent(folder)}`;
}

/**
 * Where a file's viewer goes back to: the folder it was opened from, with the file selected
 * there, so a tree that showed it shows it again.
 */
export function returnHref(path: string, from: string | null | undefined): string {
  const folder = originFolder(path, from);
  const relative = path.slice(folder === "/" ? 1 : folder.length + 1);
  return `${pathToHref(folder)}?select=${encodeURIComponent(relative)}`;
}

/**
 * The preview-route URL for `path`, e.g. "/view" or "/view/a/b%20c", remembering `from` when
 * the file was opened from a folder above its own (see `originQuery`).
 */
export function viewHref(path: string, from?: string | null): string {
  const segments = splitSegments(path);
  const base = segments.length === 0 ? "/view" : `/view/${encodeSegments(segments)}`;
  return `${base}${originQuery(path, from)}`;
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
 * The virtual fs path implied by a browser `pathname`, when it is a Files
 * route ("/files" or "/files/..."), or `null` for any other route (so
 * callers, like the sidebar tree, can tell "not on a Files page" apart from
 * "on the Files root").
 */
export function pathFromFilesPathname(pathname: string | null): string | null {
  if (pathname === "/files") {
    return "/";
  }
  if (pathname === null || !pathname.startsWith("/files/")) {
    return null;
  }
  const segments = pathname.slice("/files/".length).split("/");
  return segmentsToPath(segments);
}

/**
 * Builds the breadcrumb trail for `path`: "Home" for the root, followed by
 * one entry per segment, each linking to `pathToHref` of its own path.
 */
export function buildBreadcrumbs(
  path: string,
  names?: ReadonlyMap<string, string>,
): BreadcrumbEntry[] {
  const segments = splitSegments(path);
  const crumbs: BreadcrumbEntry[] = [{ name: "Home", path: "/", href: pathToHref("/") }];

  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    // An encrypted folder's folders show their decrypted names; the link keeps the stored one.
    crumbs.push({ name: names?.get(current) ?? segment, path: current, href: pathToHref(current) });
  }

  return crumbs;
}
