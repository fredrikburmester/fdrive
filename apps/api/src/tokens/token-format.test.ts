import { describe, expect, it } from "vitest";
import {
  generateApiToken,
  hashApiToken,
  looksLikeApiToken,
  TOKEN_LENGTH,
  TOKEN_PREFIX,
} from "./token-format.js";

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
  it("accepts every token generateApiToken mints", () => {
    for (let i = 0; i < 500; i++) {
      expect(looksLikeApiToken(generateApiToken())).toBe(true);
    }
  });

  it("accepts a token whose body uses the base64url-only characters", () => {
    // A body of 0xfb bytes encodes to the `-` and `_` that distinguish
    // base64url from base64; a check built for the wrong alphabet would
    // reject a token fdrive really does mint.
    const token = generateApiToken(() => new Uint8Array(32).fill(0xfb));
    expect(token).toContain("-");
    expect(token).toContain("_");
    expect(looksLikeApiToken(token)).toBe(true);
  });

  it("agrees with the minted length", () => {
    expect(generateApiToken()).toHaveLength(TOKEN_LENGTH);
  });

  it("rejects the prefix followed by a short body", () => {
    expect(looksLikeApiToken("fdr_x")).toBe(false);
  });

  it("rejects a body one character short", () => {
    expect(looksLikeApiToken(`${TOKEN_PREFIX}${"a".repeat(TOKEN_LENGTH - 5)}`)).toBe(false);
  });

  it("rejects a body one character long", () => {
    expect(looksLikeApiToken(`${TOKEN_PREFIX}${"a".repeat(TOKEN_LENGTH - 3)}`)).toBe(false);
  });

  it("rejects a correctly sized body with a character outside base64url", () => {
    for (const outside of ["+", "/", "=", ".", "%", " "]) {
      const body = `${outside}${"a".repeat(TOKEN_LENGTH - TOKEN_PREFIX.length - 1)}`;
      expect(looksLikeApiToken(`${TOKEN_PREFIX}${body}`)).toBe(false);
    }
  });

  it("rejects a value with just the prefix", () => {
    expect(looksLikeApiToken("fdr_")).toBe(false);
  });

  it("rejects a value without the prefix", () => {
    expect(looksLikeApiToken("x".repeat(TOKEN_LENGTH))).toBe(false);
  });

  it("rejects a minted token with surrounding whitespace", () => {
    const token = generateApiToken();
    expect(looksLikeApiToken(` ${token}`)).toBe(false);
    expect(looksLikeApiToken(`${token}\n`)).toBe(false);
  });

  it("rejects a minted token with anything appended", () => {
    expect(looksLikeApiToken(`${generateApiToken()}a`)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(looksLikeApiToken("")).toBe(false);
  });

  it("rejects a very long prefixed string", () => {
    expect(looksLikeApiToken(`${TOKEN_PREFIX}${"a".repeat(100_000)}`)).toBe(false);
  });
});
