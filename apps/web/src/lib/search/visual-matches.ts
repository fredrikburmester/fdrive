import type { ImageSearchHit } from "@fdrive/contracts";
import { isWithin, normalizePath } from "@fdrive/core";
import { SEARCH_TYPE_EXTENSIONS, type SearchChipState } from "./filters";

export interface FilterVisualHitsOptions {
  readonly chips: SearchChipState;
  readonly currentFolder: string;
  readonly shownItems: readonly {
    readonly path: string;
    readonly identityId?: string | undefined;
  }[];
  readonly activeIdentityId?: string | undefined;
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

/**
 * Truthfully labels the visual matches section heading. When all logins are
 * selected, it explicitly notes that visual search covers the active login only.
 */
export function visualMatchesHeading(
  allLogins: boolean,
  activeIdentityLabel?: string | undefined,
): string {
  if (allLogins) {
    if (activeIdentityLabel) {
      return `Visual matches (${activeIdentityLabel} only)`;
    }
    return "Visual matches (current login only)";
  }
  return "Visual matches";
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
 * 3. Deduplicates against items already displayed in text results (Files and Content)
 *    matching the same path and identity.
 */
export function filterVisualHits(
  hits: readonly ImageSearchHit[],
  options: FilterVisualHitsOptions,
): ImageSearchHit[] {
  if (!shouldQueryVisualMatches(options.chips, true)) {
    return [];
  }

  const activeId = options.activeIdentityId ?? "";
  const shownKeys = new Set<string>();
  for (const item of options.shownItems) {
    const itemId = item.identityId ?? activeId;
    shownKeys.add(`${itemId}:${normalizePath(item.path)}`);
  }

  const results: ImageSearchHit[] = [];
  for (const hit of hits) {
    if (options.chips.type === "images" && !matchesImageType(hit.ext)) {
      continue;
    }

    if (options.chips.folderOnly && !isWithin(options.currentFolder, hit.path)) {
      continue;
    }

    const hitKey = `${activeId}:${normalizePath(hit.path)}`;
    if (shownKeys.has(hitKey)) {
      continue;
    }

    results.push(hit);
  }

  return results;
}
