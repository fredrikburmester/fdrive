import { describe, expect, it } from "vitest";
import { extractCookiePair } from "./cookie.js";

describe("extractCookiePair", () => {
  it("returns undefined for a null header", () => {
    expect(extractCookiePair(null)).toBeUndefined();
  });

  it("strips attributes after the first semicolon", () => {
    const header = "fdrive_session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000";
    expect(extractCookiePair(header)).toBe("fdrive_session=abc123");
  });

  it("returns the whole value when there are no attributes", () => {
    expect(extractCookiePair("fdrive_session=abc123")).toBe("fdrive_session=abc123");
  });
});
