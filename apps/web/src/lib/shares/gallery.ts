/** Tiles shown per gallery page before "Show more" reveals another page. */
export const GALLERY_PAGE_SIZE = 200;

/** How many of `total` items are currently visible, given `shown` already requested. */
export function galleryVisibleCount(
  total: number,
  shown: number,
  pageSize = GALLERY_PAGE_SIZE,
): number {
  return Math.min(total, Math.max(shown, pageSize));
}

/** True when more items exist beyond the currently visible count. */
export function hasMoreGalleryItems(total: number, visible: number): boolean {
  return visible < total;
}

/** Wraps `current + delta` within `[0, total)`. Returns 0 when the gallery is empty. */
export function stepLightboxIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}

/**
 * The lightbox indexes worth preloading around `current`: its previous and next neighbours,
 * wrapping like `stepLightboxIndex`. Empty for a single-image (or empty) gallery, where there is
 * nothing to preload; a single-entry pair (both neighbours equal, a two-image gallery) is
 * deduplicated so the current image is never preloaded twice.
 */
export function neighborIndexes(current: number, total: number): readonly number[] {
  if (total <= 1) return [];
  const previous = stepLightboxIndex(current, total, -1);
  const next = stepLightboxIndex(current, total, 1);
  return previous === next ? [previous] : [previous, next];
}
