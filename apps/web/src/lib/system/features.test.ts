import { describe, expect, it } from "vitest";
import { changeFeature } from "./features";

const off = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};
describe("feature choices", () => {
  it("keeps both OCR toggles independent of each other", () => {
    expect(changeFeature(off, "pdfOcr", true)).toEqual({ ...off, textSearch: true, pdfOcr: true });
    expect(changeFeature(off, "searchOcr", true)).toEqual({
      ...off,
      textSearch: true,
      searchOcr: true,
    });
    const both = { ...off, textSearch: true, searchOcr: true, pdfOcr: true };
    expect(changeFeature(both, "searchOcr", false)).toEqual({ ...both, searchOcr: false });
    expect(changeFeature(both, "pdfOcr", false)).toEqual({ ...both, pdfOcr: false });
  });
  it("includes explicit prerequisites and removes dependent features", () => {
    const semantic = changeFeature(off, "semanticSearch", true);
    expect(semantic.textSearch).toBe(true);
    expect(
      changeFeature(
        { ...semantic, searchOcr: true, pdfOcr: true, thumbnails: true },
        "textSearch",
        false,
      ),
    ).toEqual({ ...off, thumbnails: true });
    expect(changeFeature(semantic, "semanticSearch", false).textSearch).toBe(true);
  });
  it("does not couple image search to browser thumbnail presentation", () => {
    expect(changeFeature(off, "imageSearch", true)).toEqual({ ...off, imageSearch: true });
    expect(changeFeature(off, "thumbnails", true)).toEqual({ ...off, thumbnails: true });
  });
});
