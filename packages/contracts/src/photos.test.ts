import { describe, expect, it } from "vitest";
import { PhotoDetailsResponse, PhotoItem } from "./photos";

describe("photos", () => {
  it("takes the camera's time without a time zone, or none", () => {
    const item = {
      path: "/a.jpg",
      name: "a.jpg",
      size: 1,
      modifiedAt: "2024-05-02T10:00:00.000Z",
      takenAt: "2024-05-01T14:03:09",
    };
    expect(PhotoItem.safeParse(item).success).toBe(true);
    expect(PhotoItem.safeParse({ ...item, takenAt: null }).success).toBe(true);
    expect(PhotoItem.safeParse({ ...item, takenAt: "yesterday" }).success).toBe(false);
  });

  it("allows every detail to be missing, but no empty size", () => {
    const none = {
      takenAt: null,
      camera: null,
      width: null,
      height: null,
      latitude: null,
      longitude: null,
    };
    expect(PhotoDetailsResponse.safeParse(none).success).toBe(true);
    expect(PhotoDetailsResponse.safeParse({ ...none, width: 0 }).success).toBe(false);
  });
});
