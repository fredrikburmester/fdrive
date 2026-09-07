import { isImageFileName, type SharePresentation } from "@fdrive/contracts";

export type ResolvedPresentation = "gallery" | "list" | "download";

export interface PresentationEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "symlink" | "other";
}

/** True when `entries` is non-empty and every entry is an image file. */
export function allImageEntries(entries: readonly PresentationEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => isImageEntry(entry));
}

function isImageEntry(entry: PresentationEntry): boolean {
  return entry.kind === "file" && isImageFileName(entry.name);
}

/** Keeps only the image files from a listing, for a gallery forced on a mixed folder. */
export function galleryEntries<T extends PresentationEntry>(entries: readonly T[]): readonly T[] {
  return entries.filter((entry) => isImageEntry(entry));
}

/**
 * Resolves a directory listing's presentation. `auto` becomes `gallery` only when every entry
 * is an image (a subfolder or a non-image file makes the listing "mixed", so it falls back to
 * `list`, matching the current folder's contents rather than the whole share tree). An explicit
 * `gallery` choice still needs at least one image to render a grid; otherwise it falls back to
 * `list` so the folder is never shown as an empty gallery.
 */
export interface PresentationOptions {
  /**
   * True when the share carries a download limit. Every gallery tile is a real download
   * through the public route and SFTPGo counts each one against that limit, so a limited
   * link is never shown as a gallery: previews would silently exhaust it.
   */
  readonly downloadLimited?: boolean;
}

export function resolveEntriesPresentation(
  presentation: SharePresentation,
  entries: readonly PresentationEntry[],
  options: PresentationOptions = {},
): ResolvedPresentation {
  if (presentation === "download") return "download";
  if (presentation === "list" || options.downloadLimited === true) return "list";
  if (presentation === "gallery")
    return entries.some((entry) => isImageEntry(entry)) ? "gallery" : "list";
  return allImageEntries(entries) ? "gallery" : "list";
}

/**
 * Resolves a single-file share's presentation. There is nothing to list for one file, so both
 * an explicit `list` choice and `download` collapse to the same download card; `gallery` (and
 * `auto`) shows a one-image gallery only when the file is an image, otherwise it also falls back
 * to `download`.
 */
export function resolveSingleFilePresentation(
  presentation: SharePresentation,
  fileName: string | null,
  options: PresentationOptions = {},
): ResolvedPresentation {
  const image = fileName !== null && isImageFileName(fileName);
  if (options.downloadLimited === true) return "download";
  if (image && (presentation === "gallery" || presentation === "auto")) return "gallery";
  return "download";
}
