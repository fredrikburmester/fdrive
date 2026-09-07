import { describe, expect, it } from "vitest";
import {
  GALLERY_PAGE_SIZE,
  galleryVisibleCount,
  hasMoreGalleryItems,
  stepLightboxIndex,
} from "./gallery";

describe("galleryVisibleCount", () => {
  it("shows at least one page, capped at the total", () => {
    expect(galleryVisibleCount(500, 0, 200)).toBe(200);
    expect(galleryVisibleCount(150, 0, 200)).toBe(150);
    expect(galleryVisibleCount(500, 200, 200)).toBe(200);
    expect(galleryVisibleCount(500, 400, 200)).toBe(400);
    expect(galleryVisibleCount(0, 0)).toBe(0);
    expect(galleryVisibleCount(1000, 0)).toBe(GALLERY_PAGE_SIZE);
  });
});

describe("hasMoreGalleryItems", () => {
  it("is true only while some items remain hidden", () => {
    expect(hasMoreGalleryItems(10, 5)).toBe(true);
    expect(hasMoreGalleryItems(10, 10)).toBe(false);
    expect(hasMoreGalleryItems(0, 0)).toBe(false);
  });
});

describe("stepLightboxIndex", () => {
  it("wraps forward and backward within the item count, and is 0 for an empty gallery", () => {
    expect(stepLightboxIndex(0, 3, 1)).toBe(1);
    expect(stepLightboxIndex(2, 3, 1)).toBe(0);
    expect(stepLightboxIndex(0, 3, -1)).toBe(2);
    expect(stepLightboxIndex(1, 3, -1)).toBe(0);
    expect(stepLightboxIndex(0, 0, 1)).toBe(0);
    expect(stepLightboxIndex(5, 1, 1)).toBe(0);
  });
});
