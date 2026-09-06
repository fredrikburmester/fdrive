import { extensionOf, joinPath } from "./paths.ts";

/**
 * The archive formats fdrive can produce. Mirrors `@fdrive/contracts`'
 * `ArchiveFormat` zod enum; kept as a plain union here so this package stays
 * dependency-free.
 */
export type ArchiveFormat = "zip" | "tar.gz" | "tar.zst";

/** The kinds of archive fdrive can extract, detected from a file name. */
export type ArchiveKind = "zip" | "tar" | "tar.gz" | "tar.zst" | "gz";

/**
 * Splits `name` into a base and its extension using the same rules as
 * `extensionOf` (dotfiles have no extension, `.tar.gz` and friends count as
 * one extension).
 */
function splitNameAndExtension(name: string): { base: string; ext: string } {
  const ext = extensionOf(name);
  return ext.length > 0
    ? { base: name.slice(0, name.length - ext.length), ext }
    : { base: name, ext: "" };
}

/**
 * Builds a unique "copy" name for `name` given the sibling names already
 * present in `existing`: "report.pdf" becomes "report copy.pdf", then
 * "report copy 2.pdf", "report copy 3.pdf", and so on. Works the same for
 * folders (no extension to preserve) and dotfiles (".env" has no extension
 * either, so it becomes ".env copy").
 */
export function uniqueCopyName(name: string, existing: ReadonlySet<string>): string {
  const { base, ext } = splitNameAndExtension(name);

  const firstCandidate = `${base} copy${ext}`;
  if (!existing.has(firstCandidate)) {
    return firstCandidate;
  }

  let n = 2;
  let candidate = `${base} copy ${n}${ext}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${base} copy ${n}${ext}`;
  }
  return candidate;
}

/** The file extension (including leading dot(s)) fdrive writes for `format`. */
export function archiveExtensionFor(format: ArchiveFormat): string {
  switch (format) {
    case "zip":
      return ".zip";
    case "tar.gz":
      return ".tar.gz";
    case "tar.zst":
      return ".tar.zst";
  }
}

/**
 * Archive suffixes recognized by `stripArchiveExtension` and
 * `detectArchiveKind`, longest (and most specific) first so a compound
 * suffix such as ".tar.gz" is matched before its own tail (".gz") would be.
 */
const ARCHIVE_SUFFIXES: readonly string[] = [".tar.gz", ".tar.zst", ".tgz", ".zip", ".tar", ".gz"];

/**
 * Strips a recognized archive suffix from `name` (case-insensitively):
 * ".tar.gz", ".tgz", ".tar.zst", ".zip", ".tar", or ".gz". Returns `name`
 * unchanged when it does not end with one of those, or when stripping the
 * suffix would leave nothing behind.
 */
export function stripArchiveExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      return name.slice(0, name.length - suffix.length);
    }
  }
  return name;
}

/**
 * Detects the archive kind implied by `name`'s extension, or `null` when it
 * matches none of the recognized suffixes. ".tgz" is reported as "tar.gz",
 * matching `archiveExtensionFor`'s own naming.
 */
export function detectArchiveKind(name: string): ArchiveKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.zst")) {
    return "tar.zst";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  if (lower.endsWith(".tar")) {
    return "tar";
  }
  if (lower.endsWith(".gz")) {
    return "gz";
  }
  return null;
}

/**
 * Resolves an archive entry name against `destination`, refusing anything
 * that could escape it: an empty name, a NUL byte, an absolute path (POSIX
 * `/...` or a Windows drive or UNC-style `\...` root), or a `..` segment
 * that would climb above `destination` itself. Backslashes are treated as
 * path separators here (archives built on Windows use them), unlike
 * `normalizePath`'s virtual paths. Intra-entry `.` and non-escaping `..`
 * segments are resolved away. Returns the joined, normalized virtual path,
 * or `null` when the entry is unsafe.
 */
export function safeEntryPath(destination: string, entryName: string): string | null {
  if (entryName.length === 0 || entryName.includes("\0")) {
    return null;
  }
  if (entryName.startsWith("/") || entryName.startsWith("\\")) {
    return null;
  }
  if (/^[a-zA-Z]:[/\\]/.test(entryName)) {
    return null;
  }

  const rawSegments = entryName.split(/[/\\]+/).filter((segment) => segment.length > 0);

  const resolved: string[] = [];
  for (const segment of rawSegments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (resolved.length === 0) {
        return null;
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  if (resolved.length === 0) {
    return null;
  }

  return joinPath(destination, ...resolved);
}
