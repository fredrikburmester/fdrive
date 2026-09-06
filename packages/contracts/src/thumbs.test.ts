import { describe, expect, it } from "vitest";
import { THUMB_SIZES, ThumbQuery } from "./thumbs";

describe("THUMB_SIZES", () => {
  it("is 256 and 1024", () => {
    expect(THUMB_SIZES).toEqual([256, 1024]);
  });
});

describe("ThumbQuery", () => {
  it("parses a valid 256 query", () => {
    expect(ThumbQuery.parse({ path: "/photo.jpg", size: "256" })).toEqual({
      path: "/photo.jpg",
      size: "256",
    });
  });

  it("parses a valid 1024 query", () => {
    expect(ThumbQuery.safeParse({ path: "/photo.jpg", size: "1024" }).success).toBe(true);
  });

  it("rejects an unsupported size", () => {
    expect(ThumbQuery.safeParse({ path: "/photo.jpg", size: "512" }).success).toBe(false);
  });

  it("rejects a missing path", () => {
    expect(ThumbQuery.safeParse({ size: "256" }).success).toBe(false);
  });
});
