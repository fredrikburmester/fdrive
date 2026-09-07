import type { SharePresentation } from "@fdrive/contracts";

/** User-facing "Show as" label for each operator-chosen presentation. */
export const PRESENTATION_LABEL: Record<SharePresentation, string> = {
  auto: "Automatic",
  list: "List",
  gallery: "Gallery",
  download: "Download only",
};

/** One-line description shown under the "Show as" field for the selected presentation. */
export const PRESENTATION_DESCRIPTION: Record<SharePresentation, string> = {
  auto: "Shows a photo grid when every shared file is an image, a list otherwise.",
  list: "Always shows a list of files, with a download button on each row.",
  gallery: "Always shows a photo grid with a full-size preview and per-image download.",
  download: "Shows one button that downloads everything, without browsing individual files.",
};

export function presentationLabel(value: SharePresentation): string {
  return PRESENTATION_LABEL[value];
}
