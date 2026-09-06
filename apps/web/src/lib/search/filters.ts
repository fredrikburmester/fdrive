/** The "Type" filter chip in the search panel. "any" sends no `ext` filter at all. */
export type SearchTypeFilter = "any" | "images" | "documents" | "audio" | "video" | "archives";

export const SEARCH_TYPE_FILTERS: readonly SearchTypeFilter[] = [
  "any",
  "images",
  "documents",
  "audio",
  "video",
  "archives",
];

/** Display label for each type chip, for the toggle group. */
export const SEARCH_TYPE_LABELS: Readonly<Record<SearchTypeFilter, string>> = {
  any: "Any type",
  images: "Images",
  documents: "Documents",
  audio: "Audio",
  video: "Video",
  archives: "Archives",
};

/** Extensions (with leading dot) each non-"any" type chip expands to. */
export const SEARCH_TYPE_EXTENSIONS: Readonly<
  Record<Exclude<SearchTypeFilter, "any">, readonly string[]>
> = {
  images: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".heic", ".heif", ".svg"],
  documents: [
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".odt",
    ".ods",
    ".odp",
    ".txt",
    ".md",
    ".csv",
  ],
  audio: [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus"],
  video: [".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"],
  archives: [".zip", ".tar", ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".gz", ".7z", ".rar"],
};

/** The search panel's filter chip state: a type (or "any") plus "this folder only". */
export interface SearchChipState {
  readonly type: SearchTypeFilter;
  readonly folderOnly: boolean;
}

export const DEFAULT_SEARCH_CHIPS: SearchChipState = { type: "any", folderOnly: false };

/** The `ext`/`folder` query parameters `ApiClient.search` accepts, derived from chip state. */
export interface SearchQueryParams {
  readonly ext: string | undefined;
  readonly folder: string | undefined;
}

/**
 * Converts filter chip state into the query parameters the search API
 * accepts: a comma-separated `ext` list for a non-"any" type chip, and
 * `folder` (the current browsing folder) when "this folder only" is on.
 */
export function chipsToQueryParams(
  chips: SearchChipState,
  currentFolder: string,
): SearchQueryParams {
  return {
    ext: chips.type === "any" ? undefined : SEARCH_TYPE_EXTENSIONS[chips.type].join(","),
    folder: chips.folderOnly ? currentFolder : undefined,
  };
}
