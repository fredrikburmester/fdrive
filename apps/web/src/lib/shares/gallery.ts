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
