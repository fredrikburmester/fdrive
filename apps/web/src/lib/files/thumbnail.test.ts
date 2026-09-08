import { describe, expect, it } from "vitest";
import { wantsGridThumbnail, wantsThumbnail } from "./thumbnail";

describe("wantsThumbnail", () => {
  it("wants a thumbnail for an image file by extension", () => {
    expect(wantsThumbnail({ kind: "file", ext: ".png", mime: null, size: 100 })).toBe(true);
  });

  it("wants a thumbnail for an image file by mime type", () => {
    expect(wantsThumbnail({ kind: "file", ext: "", mime: "image/png", size: 100 })).toBe(true);
  });

  it("does not want a thumbnail for a non-image file", () => {
    expect(wantsThumbnail({ kind: "file", ext: ".txt", mime: null, size: 100 })).toBe(false);
  });

  it("does not want a thumbnail for a folder, even with an image-like extension", () => {
    expect(wantsThumbnail({ kind: "dir", ext: ".png", mime: null, size: 100 })).toBe(false);
  });

  it("matches wantsGridThumbnail alias", () => {
    expect(wantsGridThumbnail).toBe(wantsThumbnail);
  });
});
