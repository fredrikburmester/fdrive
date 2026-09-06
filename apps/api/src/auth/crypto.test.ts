import { describe, expect, it } from "vitest";
import { CryptoError, KEY_ID, open, parseMasterKey, seal } from "./crypto";

const MASTER = parseMasterKey(Buffer.alloc(32, 7).toString("base64"));
const OTHER_MASTER = parseMasterKey(Buffer.alloc(32, 42).toString("base64"));
const AAD = "identity-1";

describe("KEY_ID", () => {
  it("is the fixed master-v1 label", () => {
    expect(KEY_ID).toBe("master-v1");
  });
});

describe("parseMasterKey", () => {
  it("decodes valid base64 to a 32-byte key", () => {
    const key = parseMasterKey(Buffer.alloc(32, 1).toString("base64"));
    expect(key).toHaveLength(32);
  });

  it("throws when the decoded key is shorter than 32 bytes", () => {
    expect(() => parseMasterKey(Buffer.alloc(16, 1).toString("base64"))).toThrow(CryptoError);
  });

  it("throws when the decoded key is longer than 32 bytes", () => {
    expect(() => parseMasterKey(Buffer.alloc(48, 1).toString("base64"))).toThrow(CryptoError);
  });
});

describe("seal/open round trip", () => {
  it("recovers the original plaintext", () => {
    const plaintext = new TextEncoder().encode(JSON.stringify({ password: "hunter2" }));
    const blob = seal(MASTER, plaintext, AAD);

    const opened = open(MASTER, blob, AAD);

    expect(new TextDecoder().decode(opened)).toBe(JSON.stringify({ password: "hunter2" }));
  });

  it("produces a different blob each time (random iv/data key)", () => {
    const plaintext = new TextEncoder().encode("same input");
    const first = seal(MASTER, plaintext, AAD);
    const second = seal(MASTER, plaintext, AAD);

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });

  it("round-trips empty plaintext", () => {
    const blob = seal(MASTER, new Uint8Array(0), AAD);
    const opened = open(MASTER, blob, AAD);
    expect(opened).toHaveLength(0);
  });
});

describe("open failure modes", () => {
  it("throws on a version byte other than 1", () => {
    const blob = seal(MASTER, new TextEncoder().encode("x"), AAD);
    const tampered = Buffer.from(blob);
    tampered[0] = 0x02;

    expect(() => open(MASTER, tampered, AAD)).toThrow(CryptoError);
    expect(() => open(MASTER, tampered, AAD)).toThrow(/version/);
  });

  it("throws on a blob shorter than the fixed header", () => {
    expect(() => open(MASTER, new Uint8Array(10), AAD)).toThrow(CryptoError);
    expect(() => open(MASTER, new Uint8Array(10), AAD)).toThrow(/truncated/);
  });

  it("throws when the master key is wrong", () => {
    const blob = seal(MASTER, new TextEncoder().encode("secret"), AAD);

    expect(() => open(OTHER_MASTER, blob, AAD)).toThrow(CryptoError);
  });

  it("throws when the aad is wrong", () => {
    const blob = seal(MASTER, new TextEncoder().encode("secret"), AAD);

    expect(() => open(MASTER, blob, "different-identity")).toThrow(CryptoError);
  });

  it.each([
    ["wrapIv", 1],
    ["wrappedKey", 13],
    ["wrapTag", 45],
    ["iv", 61],
    ["tag", 73],
    ["ciphertext", 89],
  ])("throws when a byte in the %s region is tampered", (_region, byteOffset) => {
    const blob = seal(MASTER, new TextEncoder().encode("tamper-target"), AAD);
    const tampered = Buffer.from(blob);
    const original = tampered[byteOffset];
    if (original === undefined) {
      throw new Error("test setup error: byteOffset out of range for this plaintext length");
    }
    tampered[byteOffset] = original ^ 0xff;

    expect(() => open(MASTER, tampered, AAD)).toThrow(CryptoError);
  });
});

describe("fixed vector", () => {
  // Generated once with a fixed master key, aad, data key, and IVs, then
  // inlined here so a future refactor of the wire format is caught by this
  // test even if seal()/open() both still round-trip with each other.
  const FIXED_MASTER = parseMasterKey(Buffer.alloc(32, 7).toString("base64"));
  const FIXED_AAD = "identity-fixed";
  const FIXED_BLOB_BASE64 =
    "AQEBAQEBAQEBAQEBAX/ogL6ZtuUH2N3VKHk+eTih8h39EZ4yGlE4SmtvvT+ySU7BH09C2eml3C79RXLOzQICAgICAgICAgICAkAqDI4xnRdMcUxuY6mVjeWScYoYMWL2IJ2KbVU=";

  it("decrypts a known-good blob to the expected plaintext", () => {
    const blob = Buffer.from(FIXED_BLOB_BASE64, "base64");

    const plaintext = open(FIXED_MASTER, blob, FIXED_AAD);

    expect(new TextDecoder().decode(plaintext)).toBe("hello fdrive");
  });
});
