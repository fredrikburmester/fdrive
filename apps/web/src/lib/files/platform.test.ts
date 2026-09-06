import { describe, expect, it } from "vitest";
import { detectPlatform } from "./platform";

describe("detectPlatform", () => {
  it("returns other when there is no navigator", () => {
    expect(detectPlatform(undefined)).toBe("other");
  });

  it("detects mac from platform", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
  });

  it("detects mac from userAgent when platform is absent", () => {
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)" })).toBe(
      "mac",
    );
  });

  it("detects iPad as mac", () => {
    expect(detectPlatform({ platform: "iPad" })).toBe("mac");
  });

  it("returns other for Windows", () => {
    expect(detectPlatform({ platform: "Win32" })).toBe("other");
  });

  it("returns other when neither field is present", () => {
    expect(detectPlatform({})).toBe("other");
  });
});
