import { describe, expect, it } from "vitest";
import { wantsGridThumbnail } from "./thumbnail";

describe("wantsGridThumbnail", () => {
  it("wants a thumbnail for an image file by extension", () => {
    expect(wantsGridThumbnail({ kind: "file", ext: ".png", mime: null, size: 100 })).toBe(true);
  });

  it("wants a thumbnail for an image file by mime type", () => {
    expect(wantsGridThumbnail({ kind: "file", ext: "", mime: "image/png", size: 100 })).toBe(true);
  });

  it("does not want a thumbnail for a non-image file", () => {
    expect(wantsGridThumbnail({ kind: "file", ext: ".txt", mime: null, size: 100 })).toBe(false);
  });

  it("does not want a thumbnail for a folder, even with an image-like extension", () => {
    expect(wantsGridThumbnail({ kind: "dir", ext: ".png", mime: null, size: 100 })).toBe(false);
  });
});
