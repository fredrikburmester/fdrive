import { CoreError } from "./errors.ts";

const MAX_SEGMENT_BYTES = 255;

/** Archive suffixes treated as a single extension, as filesai's indexer does. */
const COMPOUND_EXTENSIONS: readonly string[] = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"];

const textEncoder = new TextEncoder();

/**
 * Normalizes a virtual path: POSIX-style, absolute, "/" is the root.
 *
 * - "" and "/" both normalize to "/".
 * - A missing leading slash is added.
 * - Repeated slashes collapse.
 * - "." segments are dropped and ".." segments pop the previous segment,
 *   never escaping the root (extra ".." at the root are absorbed, not
 *   errors).
 * - The trailing slash is stripped, except for the root itself.
 * - Backslashes are ordinary characters, never a separator.
 *
 * Throws `CoreError("invalid_path")` when the input contains a NUL byte or
 * a segment whose UTF-8 encoding exceeds 255 bytes.
 */
export function normalizePath(input: string): string {
  if (input.includes("\0")) {
    throw new CoreError("invalid_path", "path must not contain a NUL byte", { input });
  }

  const withLeadingSlash = input.startsWith("/") ? input : `/${input}`;
  const rawSegments = withLeadingSlash.split("/").filter((segment) => segment.length > 0);

  const resolved: string[] = [];
  for (const segment of rawSegments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    if (textEncoder.encode(segment).length > MAX_SEGMENT_BYTES) {
      throw new CoreError("invalid_path", "path segment exceeds 255 bytes", { segment });
    }
    resolved.push(segment);
  }

  return resolved.length === 0 ? "/" : `/${resolved.join("/")}`;
}

/**
 * Joins a base path with any number of extra segments (or sub-paths) and
 * normalizes the result.
 */
export function joinPath(base: string, ...segments: string[]): string {
  return normalizePath([base, ...segments].join("/"));
}

/** Splits a normalized path into its segments. `[]` for the root. */
export function splitSegments(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}

/** The parent of `path`. "/" for the root and for any top-level entry. */
export function parentPath(path: string): string {
  const segments = splitSegments(path);
  return segments.length <= 1 ? "/" : `/${segments.slice(0, -1).join("/")}`;
}

/** The final path segment. "" for the root. */
export function baseName(path: string): string {
  const segments = splitSegments(path);
  return segments.length === 0 ? "" : (segments.at(-1) ?? "");
}

/** True when `path` normalizes to the root. */
export function isRoot(path: string): boolean {
  return normalizePath(path) === "/";
}

/** True when `child` equals `parent` or is nested below it. */
export function isWithin(parent: string, child: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedChild = normalizePath(child);
  if (normalizedParent === "/") {
    return true;
  }
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

/**
 * The path of `child` relative to `parent`, as segments joined by "/".
 * "" when they are equal, `null` when `child` is not within `parent`.
 */
export function relativeTo(parent: string, child: string): string | null {
  const normalizedParent = normalizePath(parent);
  const normalizedChild = normalizePath(child);
  if (!isWithin(normalizedParent, normalizedChild)) {
    return null;
  }
  if (normalizedChild === normalizedParent) {
    return "";
  }
  return normalizedParent === "/"
    ? normalizedChild.slice(1)
    : normalizedChild.slice(normalizedParent.length + 1);
}

/**
 * The lowercase extension (with leading dot) of a file name, "" when there
 * is none. Dotfiles such as ".env" have no extension. Recognized compound
 * archive suffixes (".tar.gz" and friends) are treated as one extension.
 */
export function extensionOf(name: string): string {
  const lower = name.toLowerCase();

  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.length > compound.length && lower.endsWith(compound)) {
      return compound;
    }
  }

  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) {
    return "";
  }
  return lower.slice(lastDot);
}

/**
 * True when `segment` is a single, safe path segment: non-empty, no "/",
 * no NUL byte, and not "." or "..".
 */
export function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !segment.includes("/") &&
    !segment.includes("\0") &&
    segment !== "." &&
    segment !== ".."
  );
}

/**
 * Returns `path` with its final segment replaced by `newName`. Throws
 * `CoreError("invalid_argument")` when `newName` is not a safe segment.
 */
export function changeBaseName(path: string, newName: string): string {
  if (!isSafeSegment(newName)) {
    throw new CoreError("invalid_argument", "newName is not a safe path segment", { newName });
  }
  return joinPath(parentPath(path), newName);
}
