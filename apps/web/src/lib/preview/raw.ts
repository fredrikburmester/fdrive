import { RAW_IMAGE_EXTENSIONS } from "@fdrive/contracts";

/**
 * True when `ext` (case-insensitive, with leading dot) is a camera raw extension.
 * No browser decodes these: every surface shows the indexer's thumbnail, built from
 * the JPEG preview the camera embeds, and offers the original as a download.
 */
export function isRawExt(ext: string): boolean {
  return RAW_IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/** The reason shown when a raw file has no thumbnail to stand in for it. */
export const RAW_NO_THUMBNAIL =
  "Raw photos show their indexed thumbnail, and this file has none yet";
