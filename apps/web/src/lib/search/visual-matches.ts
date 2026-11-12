import type { ImageSearchHit } from "@fdrive/contracts";
import { isWithin, normalizePath } from "@fdrive/core";
import { SEARCH_TYPE_EXTENSIONS, type SearchChipState } from "./filters";

export interface FilterVisualHitsOptions {
  readonly chips: SearchChipState;
  readonly currentFolder: string;
  /** Paths already shown under Files or Content matches. */
  readonly shownPaths: readonly string[];
}

/**
 * Returns whether visual search should be queried for the given filter chips
 * and sidecar availability status. Non-image file types skip the visual query.
 */
export function shouldQueryVisualMatches(
  chips: SearchChipState,
  imagesAvailable: boolean,
): boolean {
  if (!imagesAvailable) {
    return false;
  }
  return chips.type === "any" || chips.type === "images";
}

/**
 * Returns whether visual hits are filtered locally rather than by the backend.
 * The backend search endpoint queries globally without folder scoping, so
 * folder filtering is performed on returned candidates client side.
 */
export function isVisualFilteredLocally(chips: SearchChipState): boolean {
  return chips.folderOnly;
}

function matchesImageType(ext: string): boolean {
  const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return SEARCH_TYPE_EXTENSIONS.images.includes(normalized);
}

/**
 * Filters and deduplicates image search hits.
 *
 * 1. Checks file type filter. If set to a non-image type, returns no hits.
 *    If set to images, validates the extension against image extensions.
 * 2. Checks folder boundary filter when folderOnly is active.
 * 3. Deduplicates against paths already displayed in text results (Files and Content).
 */
export function filterVisualHits(
  hits: readonly ImageSearchHit[],
  options: FilterVisualHitsOptions,
): ImageSearchHit[] {
  if (!shouldQueryVisualMatches(options.chips, true)) {
    return [];
  }

  const shownPaths = new Set(options.shownPaths.map(normalizePath));

  const results: ImageSearchHit[] = [];
  for (const hit of hits) {
    if (options.chips.type === "images" && !matchesImageType(hit.ext)) {
      continue;
    }

    if (options.chips.folderOnly && !isWithin(options.currentFolder, hit.path)) {
      continue;
    }

    if (shownPaths.has(normalizePath(hit.path))) {
      continue;
    }

    results.push(hit);
  }

  return results;
}
