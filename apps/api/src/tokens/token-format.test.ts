import { describe, expect, it } from "vitest";
import { generateApiToken, hashApiToken, looksLikeApiToken, TOKEN_PREFIX } from "./token-format.js";

describe("generateApiToken", () => {
  it("starts with the fdr_ prefix", () => {
    expect(generateApiToken()).toMatch(/^fdr_/);
  });

  it("produces different tokens on each call by default", () => {
    expect(generateApiToken()).not.toBe(generateApiToken());
  });

  it("encodes the given random bytes as base64url", () => {
    const token = generateApiToken(() => new Uint8Array([0, 1, 2, 3, 255]));
    expect(token).toBe(`${TOKEN_PREFIX}${Buffer.from([0, 1, 2, 3, 255]).toString("base64url")}`);
  });
});

describe("hashApiToken", () => {
  it("hashes deterministically", () => {
    expect(hashApiToken("fdr_abc")).toBe(hashApiToken("fdr_abc"));
  });

  it("produces a 64-character hex string", () => {
    expect(hashApiToken("fdr_abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes different tokens differently", () => {
    expect(hashApiToken("fdr_abc")).not.toBe(hashApiToken("fdr_def"));
  });
});

describe("looksLikeApiToken", () => {
  it("accepts a value with the fdr_ prefix and a body", () => {
    expect(looksLikeApiToken("fdr_abc")).toBe(true);
  });

  it("rejects a value with just the prefix", () => {
    expect(looksLikeApiToken("fdr_")).toBe(false);
  });

  it("rejects a value without the prefix", () => {
    expect(looksLikeApiToken("abc")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(looksLikeApiToken("")).toBe(false);
  });
});
