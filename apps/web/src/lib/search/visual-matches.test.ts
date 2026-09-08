import type { ImageSearchHit } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  filterVisualHits,
  isVisualFilteredLocally,
  shouldQueryVisualMatches,
  visualMatchesHeading,
} from "./visual-matches";

const sampleHits: readonly ImageSearchHit[] = [
  {
    name: "sunset.jpg",
    path: "/photos/sunset.jpg",
    ext: ".jpg",
    mime: "image/jpeg",
    size: 1024,
    modifiedAt: "2026-01-01T00:00:00Z",
    score: 0.9,
  },
  {
    name: "nested.png",
    path: "/photos/nature/nested.png",
    ext: "png",
    mime: "image/png",
    size: 2048,
    modifiedAt: "2026-01-01T00:00:00Z",
    score: 0.8,
  },
  {
    name: "outside.webp",
    path: "/other/outside.webp",
    ext: ".webp",
    mime: "image/webp",
    size: 512,
    modifiedAt: "2026-01-01T00:00:00Z",
    score: 0.7,
  },
  {
    name: "document.pdf",
    path: "/photos/document.pdf",
    ext: ".pdf",
    mime: "application/pdf",
    size: 4096,
    modifiedAt: "2026-01-01T00:00:00Z",
    score: 0.6,
  },
];

describe("shouldQueryVisualMatches", () => {
  it("returns false if images sidecar is not available", () => {
    expect(shouldQueryVisualMatches({ type: "any", folderOnly: false }, false)).toBe(false);
    expect(shouldQueryVisualMatches({ type: "images", folderOnly: false }, false)).toBe(false);
  });

  it("returns true for any and images types when available", () => {
    expect(shouldQueryVisualMatches({ type: "any", folderOnly: false }, true)).toBe(true);
    expect(shouldQueryVisualMatches({ type: "images", folderOnly: false }, true)).toBe(true);
  });

  it("returns false for non-image types even when available", () => {
    expect(shouldQueryVisualMatches({ type: "documents", folderOnly: false }, true)).toBe(false);
    expect(shouldQueryVisualMatches({ type: "audio", folderOnly: false }, true)).toBe(false);
    expect(shouldQueryVisualMatches({ type: "video", folderOnly: false }, true)).toBe(false);
    expect(shouldQueryVisualMatches({ type: "archives", folderOnly: false }, true)).toBe(false);
  });
});

describe("isVisualFilteredLocally", () => {
  it("returns true only when folderOnly is active", () => {
    expect(isVisualFilteredLocally({ type: "any", folderOnly: true })).toBe(true);
    expect(isVisualFilteredLocally({ type: "any", folderOnly: false })).toBe(false);
  });
});

describe("visualMatchesHeading", () => {
  it("returns standard heading when allLogins is false", () => {
    expect(visualMatchesHeading(false, "ada · Main")).toBe("Visual matches");
    expect(visualMatchesHeading(false)).toBe("Visual matches");
  });

  it("truthfully labels active identity scope when allLogins is true", () => {
    expect(visualMatchesHeading(true, "ada · Main")).toBe("Visual matches (ada · Main only)");
    expect(visualMatchesHeading(true)).toBe("Visual matches (current login only)");
  });
});

describe("filterVisualHits", () => {
  it("returns empty array if chips type is non-image", () => {
    const result = filterVisualHits(sampleHits, {
      chips: { type: "documents", folderOnly: false },
      currentFolder: "/",
      shownItems: [],
    });
    expect(result).toHaveLength(0);
  });

  it("passes all hits for type any when no folder filtering or dedup applies", () => {
    const result = filterVisualHits(sampleHits, {
      chips: { type: "any", folderOnly: false },
      currentFolder: "/",
      shownItems: [],
    });
    expect(result).toHaveLength(4);
  });

  it("filters non-image extensions when chips type is images", () => {
    const result = filterVisualHits(sampleHits, {
      chips: { type: "images", folderOnly: false },
      currentFolder: "/",
      shownItems: [],
    });
    expect(result.map((h) => h.name)).toEqual(["sunset.jpg", "nested.png", "outside.webp"]);
  });

  it("respects boundary-aware folder filtering", () => {
    const result = filterVisualHits(sampleHits, {
      chips: { type: "any", folderOnly: true },
      currentFolder: "/photos",
      shownItems: [],
    });
    expect(result.map((h) => h.name)).toEqual(["sunset.jpg", "nested.png", "document.pdf"]);
  });

  it("rejects paths with matching prefix but not on slash boundary", () => {
    const hitsWithPrefixMismatch: readonly ImageSearchHit[] = [
      {
        name: "test.jpg",
        path: "/photosextra/test.jpg",
        ext: ".jpg",
        mime: "image/jpeg",
        size: 1,
        modifiedAt: "2026-01-01T00:00:00Z",
        score: 0.9,
      },
      {
        name: "in-folder.jpg",
        path: "/photos/in-folder.jpg",
        ext: ".jpg",
        mime: "image/jpeg",
        size: 1,
        modifiedAt: "2026-01-01T00:00:00Z",
        score: 0.9,
      },
    ];

    const result = filterVisualHits(hitsWithPrefixMismatch, {
      chips: { type: "any", folderOnly: true },
      currentFolder: "/photos",
      shownItems: [],
    });
    expect(result.map((h) => h.name)).toEqual(["in-folder.jpg"]);
  });

  it("deduplicates hits already shown in text results for the same identity", () => {
    const result = filterVisualHits(sampleHits, {
      chips: { type: "any", folderOnly: false },
      currentFolder: "/",
      shownItems: [{ path: "/photos/sunset.jpg", identityId: "user-1" }],
      activeIdentityId: "user-1",
    });
    expect(result.map((h) => h.name)).toEqual(["nested.png", "outside.webp", "document.pdf"]);
  });

  it("does not deduplicate hits when identity differs", () => {
    const result = filterVisualHits(sampleHits, {
      chips: { type: "any", folderOnly: false },
      currentFolder: "/",
      shownItems: [{ path: "/photos/sunset.jpg", identityId: "other-user" }],
      activeIdentityId: "user-1",
    });
    expect(result.map((h) => h.name)).toEqual([
      "sunset.jpg",
      "nested.png",
      "outside.webp",
      "document.pdf",
    ]);
  });

  it("handles normalized paths when comparing shown items", () => {
    const result = filterVisualHits(sampleHits, {
      chips: { type: "any", folderOnly: false },
      currentFolder: "/",
      shownItems: [{ path: "photos/sunset.jpg", identityId: "user-1" }],
      activeIdentityId: "user-1",
    });
    expect(result.map((h) => h.name)).toEqual(["nested.png", "outside.webp", "document.pdf"]);
  });
});
