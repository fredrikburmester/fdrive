import { type PreviewableEntry, previewKindFor } from "@/lib/preview/kind";

/** The minimal entry shape `wantsGridThumbnail` needs. */
export interface ThumbnailableEntry extends PreviewableEntry {
  readonly kind: "file" | "dir" | "symlink" | "other";
}

/**
 * Whether a row or grid tile for `entry` should attempt an image thumbnail instead
 * of the plain file-kind icon. Only regular files whose extension or mime
 * type the preview logic already classifies as "image" qualify; folders and
 * every other preview kind keep the icon. Reuses `previewKindFor` (shared
 * with the viewer route) rather than duplicating its extension and mime
 * lists here.
 */
export function wantsThumbnail(entry: ThumbnailableEntry): boolean {
  return entry.kind === "file" && previewKindFor(entry) === "image";
}

/** Alias for `wantsThumbnail` used by grid tiles. */
export const wantsGridThumbnail = wantsThumbnail;
