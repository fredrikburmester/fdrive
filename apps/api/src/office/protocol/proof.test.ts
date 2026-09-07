import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildExpectedProof,
  decodeBase64,
  importProofKey,
  type ProofInput,
  type RsaProofKey,
  verifyProof,
} from "./proof.ts";
import { officialKeys, officialVectors } from "./proof-vectors.fixture.ts";

const current = generateKeyPairSync("rsa", { modulusLength: 2048 });
const old = generateKeyPairSync("rsa", { modulusLength: 2048 });
function publicParts(key: typeof current): RsaProofKey {
  const jwk = key.publicKey.export({ format: "jwk" });
  if (!jwk.n || !jwk.e) throw new Error("Missing RSA parts");
  return {
    modulus: Buffer.from(jwk.n, "base64url").toString("base64"),
    exponent: Buffer.from(jwk.e, "base64url").toString("base64"),
  };
}
const keys = { current: publicParts(current), old: publicParts(old) };
const nowMs = 1788652800000;
const ticks = BigInt(nowMs) * 10000n + 621355968000000000n;
const base = {
  accessToken: "tökén🚀",
  url: "https://host/wopi/files/1?access_token=t%C3%B6k%C3%A9n&x=a+b",
  timestamp: String(ticks),
  keys,
  nowMs,
};
function signed(key = current, timestamp = ticks): string {
  return sign(
    "RSA-SHA256",
    buildExpectedProof(base.accessToken, base.url, timestamp),
    key.privateKey,
  ).toString("base64");
}

describe("WOPI proof verification", () => {
  it.each(officialVectors)("Microsoft vector $name", (vector) => {
    const result = verifyProof({
      ...vector,
      keys: {
        current: { modulus: officialKeys.modulus, exponent: officialKeys.exponent },
        old: { modulus: officialKeys.oldmodulus, exponent: officialKeys.oldexponent },
      },
      nowMs: Number((BigInt(vector.timestamp) - 621355968000000000n) / 10000n),
    });
    expect(result.valid).toBe(vector.valid);
  });
  it("uses UTF-8 byte lengths and uppercase full URL", () => {
    const value = buildExpectedProof("ä🚀", "https://h/ß?q=é", 3n);
    const token = Buffer.from("ä🚀");
    const url = Buffer.from("HTTPS://H/SS?Q=É");
    expect(value.readUInt32BE(0)).toBe(6);
    expect(value.subarray(4, 10)).toEqual(token);
    expect(value.readUInt32BE(10)).toBe(url.length);
    expect(value.subarray(14, 14 + url.length)).toEqual(url);
    expect(value.readUInt32BE(14 + url.length)).toBe(8);
    expect(value.readBigInt64BE(18 + url.length)).toBe(3n);
  });
  it("accepts current key without refresh", () => {
    expect(verifyProof({ ...base, proof: signed(), oldProof: "AAAA" })).toEqual({
      valid: true,
      refreshRecommended: false,
    });
    expect(verifyProof({ ...base, keys: { current: keys.current }, proof: signed() }).valid).toBe(
      true,
    );
  });
  it("accepts both rotation cases and recommends refresh", () => {
    expect(verifyProof({ ...base, oldProof: signed() })).toEqual({
      valid: true,
      refreshRecommended: true,
    });
    expect(verifyProof({ ...base, proof: signed(old) })).toEqual({
      valid: true,
      refreshRecommended: true,
    });
  });
  it("rejects old proof with old key alone and changed query", () => {
    expect(verifyProof({ ...base, oldProof: signed(old) })).toEqual({
      valid: false,
      refreshRecommended: true,
      reason: "signature",
    });
    expect(verifyProof({ ...base, proof: signed(), url: `${base.url}&extra=1` }).valid).toBe(false);
    expect(verifyProof({ ...base, keys: { current: keys.current }, proof: "AAAA" }).valid).toBe(
      false,
    );
  });
  it.each([-20 * 60 * 10000000, 5 * 60 * 10000000])("accepts timestamp boundary %s", (offset) => {
    const ts = ticks + BigInt(offset);
    expect(verifyProof({ ...base, timestamp: String(ts), proof: signed(current, ts) }).valid).toBe(
      true,
    );
  });
  it.each([-20n * 60n * 10000000n - 1n, 5n * 60n * 10000000n + 1n])(
    "rejects timestamp outside boundary %s",
    (offset) => {
      expect(verifyProof({ ...base, timestamp: String(ticks + offset), proof: signed() })).toEqual({
        valid: false,
        refreshRecommended: false,
        reason: "timestamp",
      });
    },
  );
  it.each<Partial<ProofInput>>([
    { timestamp: "-1" },
    { timestamp: "1.5" },
    { timestamp: " 1" },
    { timestamp: "9223372036854775808" },
    { timestamp: "12345678901234567890" },
    { nowMs: Number.NaN },
    { accessToken: "" },
    { url: "file:///x" },
    { proof: "!" },
    { oldProof: "!" },
    { proof: "" },
    { keys: { current: { modulus: "!", exponent: "AQAB" } } },
  ])("rejects malformed input %j without throwing", (patch) => {
    expect(verifyProof({ ...base, proof: signed(), ...patch })).toEqual({
      valid: false,
      refreshRecommended: false,
      reason: "malformed",
    });
  });
  it("rejects missing proof headers", () => {
    expect(verifyProof(base)).toEqual({
      valid: false,
      refreshRecommended: false,
      reason: "malformed",
    });
  });
});

describe("strict RSA inputs", () => {
  it("decodes canonical base64", () => {
    expect(decodeBase64("Zg==").toString()).toBe("f");
  });
  it.each(["", "Zg", "Zh==", " Zg==", "a".repeat(8193), "AA-_"])(
    "rejects malformed base64 %s",
    (value) => {
      expect(() => decodeBase64(value)).toThrow();
    },
  );
  it.each([
    { modulus: Buffer.alloc(255).toString("base64"), exponent: "AQAB" },
    { modulus: Buffer.alloc(1025).toString("base64"), exponent: "AQAB" },
    { modulus: keys.current.modulus, exponent: Buffer.alloc(9).toString("base64") },
    { modulus: keys.current.modulus, exponent: "AQ==" },
    { modulus: keys.current.modulus, exponent: "Ag==" },
  ])("rejects unsupported RSA inputs", (key) => expect(() => importProofKey(key)).toThrow());
});
