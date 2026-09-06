import { SftpgoError } from "./errors.js";

/**
 * Validates that a virtual path is usable: it must start with "/" and must
 * not contain a NUL byte. This is the only validation the client performs;
 * it does not normalize "." or ".." segments, collapse repeated slashes, or
 * otherwise rewrite the path.
 */
export function assertValidPath(path: string): void {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new SftpgoError(
      `Invalid SFTPGo virtual path: ${JSON.stringify(path)}`,
      "bad_request",
      null,
      null,
    );
  }
}

/**
 * Returns the parent directory of a virtual path. The parent of "/" is "/".
 * A trailing slash (other than the root itself) is stripped before finding
 * the last segment.
 */
export function dirnameOf(path: string): string {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }
  return trimmed.slice(0, lastSlash);
}

/**
 * Joins a directory path and a single path segment (no slashes allowed in
 * the segment) into a child virtual path.
 */
export function joinPath(dir: string, segment: string): string {
  return dir === "/" ? `/${segment}` : `${dir}/${segment}`;
}

/**
 * Normalizes a virtual path for use as a map key: strips a trailing slash
 * (other than the root itself). Does not resolve "." or ".." segments.
 */
export function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path === "" ? "/" : path;
}
