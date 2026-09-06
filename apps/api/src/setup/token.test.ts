import { describe, expect, it } from "vitest";
import { createSetupTokenGuard, generateSetupToken, timingSafeEqualStrings } from "./token.js";

describe("generateSetupToken", () => {
  it("generates a base64url string of the expected length", () => {
    const token = generateSetupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(30);
  });

  it("generates a different token on each call", () => {
    expect(generateSetupToken()).not.toBe(generateSetupToken());
  });
});

describe("timingSafeEqualStrings", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqualStrings("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqualStrings("abc", "abd")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeEqualStrings("abc", "abcd")).toBe(false);
  });
});

describe("createSetupTokenGuard", () => {
  it("verifies the correct token", () => {
    const guard = createSetupTokenGuard("secret-token");
    expect(guard.verify("secret-token")).toBe(true);
  });

  it("rejects an incorrect token", () => {
    const guard = createSetupTokenGuard("secret-token");
    expect(guard.verify("wrong-token")).toBe(false);
  });

  it("rejects an undefined candidate", () => {
    const guard = createSetupTokenGuard("secret-token");
    expect(guard.verify(undefined)).toBe(false);
  });

  it("rejects the correct token once invalidated", () => {
    const guard = createSetupTokenGuard("secret-token");
    guard.invalidate();
    expect(guard.verify("secret-token")).toBe(false);
  });

  it("exposes the raw token", () => {
    const guard = createSetupTokenGuard("secret-token");
    expect(guard.token).toBe("secret-token");
  });
});
