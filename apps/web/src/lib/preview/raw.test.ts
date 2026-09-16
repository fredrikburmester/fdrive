import { describe, expect, it } from "vitest";
import { isRawExt } from "./raw";

describe("isRawExt", () => {
  it("identifies camera raw extensions case-insensitively", () => {
    expect(isRawExt(".arw")).toBe(true);
    expect(isRawExt(".ARW")).toBe(true);
    expect(isRawExt(".cr3")).toBe(true);
    expect(isRawExt(".dng")).toBe(true);
  });

  it("returns false for browser-decodable images and HEIC", () => {
    expect(isRawExt(".jpg")).toBe(false);
    expect(isRawExt(".heic")).toBe(false);
    expect(isRawExt("")).toBe(false);
  });
});
