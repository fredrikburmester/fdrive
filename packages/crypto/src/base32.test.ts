import { describe, expect, it } from "vitest";
import { decodeBase32, encodeBase32 } from "./base32.ts";

describe("base32", () => {
  it("encodes RFC 4648 test strings in lowercase without padding", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["f", "my"],
      ["fo", "mzxq"],
      ["foo", "mzxw6"],
      ["foob", "mzxw6yq"],
      ["fooba", "mzxw6ytb"],
      ["foobar", "mzxw6ytboi"],
    ];
    for (const [plain, encoded] of cases) {
      expect(encodeBase32(new TextEncoder().encode(plain))).toBe(encoded);
      expect(new TextDecoder().decode(decodeBase32(encoded) ?? undefined)).toBe(plain);
    }
  });

  it("round-trips every length up to 64 bytes", () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    }
  });

  it("refuses characters outside the lowercase alphabet", () => {
    expect(decodeBase32("MZXQ")).toBeNull();
    expect(decodeBase32("mzx1")).toBeNull();
  });

  it("refuses lengths no byte string encodes to", () => {
    expect(decodeBase32("m")).toBeNull();
    expect(decodeBase32("mzx")).toBeNull();
    expect(decodeBase32("mzxw6y")).toBeNull();
  });

  it("refuses non-zero spare bits", () => {
    expect(decodeBase32("mz")).toBeNull();
  });
});
