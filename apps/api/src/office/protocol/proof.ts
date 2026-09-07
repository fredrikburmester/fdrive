import { createPublicKey, verify } from "node:crypto";

export interface RsaProofKey {
  readonly modulus: string;
  readonly exponent: string;
}
export interface ProofKeys {
  readonly current: RsaProofKey;
  readonly old?: RsaProofKey;
}
export interface ProofInput {
  readonly accessToken: string;
  /** Full callback URL supplied by trusted configuration, including query. */
  readonly url: string;
  readonly timestamp: string;
  readonly proof?: string;
  readonly oldProof?: string;
  readonly keys: ProofKeys;
  readonly nowMs: number;
}
export type ProofResult =
  | { readonly valid: true; readonly refreshRecommended: boolean }
  | {
      readonly valid: false;
      readonly refreshRecommended: boolean;
      readonly reason: "malformed" | "timestamp" | "signature";
    };

const EPOCH_TICKS = 621355968000000000n;
const MAX_TICKS = 9223372036854775807n;

export function decodeBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length > 8192 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("Invalid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Noncanonical base64");
  return decoded;
}

export function importProofKey(key: RsaProofKey) {
  const modulus = decodeBase64(key.modulus);
  const exponent = decodeBase64(key.exponent);
  if (modulus.length < 256 || modulus.length > 1024 || exponent.length > 8) {
    throw new Error("Unsupported RSA key size");
  }
  const exponentValue = BigInt(`0x${exponent.toString("hex")}`);
  if (exponentValue < 3n || exponentValue % 2n === 0n) throw new Error("Invalid RSA exponent");
  return createPublicKey({
    key: { kty: "RSA", n: modulus.toString("base64url"), e: exponent.toString("base64url") },
    format: "jwk",
  });
}

/** Microsoft WOPI proof layout uses byte lengths and a binary signed 64-bit timestamp.
 * https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/scenarios/proofkeys
 */
export function buildExpectedProof(accessToken: string, url: string, timestamp: bigint): Buffer {
  const token = Buffer.from(accessToken, "utf8");
  const upperUrl = Buffer.from(url.toUpperCase(), "utf8");
  const data = Buffer.alloc(4 + token.length + 4 + upperUrl.length + 4 + 8);
  let offset = 0;
  data.writeUInt32BE(token.length, offset);
  offset += 4;
  token.copy(data, offset);
  offset += token.length;
  data.writeUInt32BE(upperUrl.length, offset);
  offset += 4;
  upperUrl.copy(data, offset);
  offset += upperUrl.length;
  data.writeUInt32BE(8, offset);
  data.writeBigInt64BE(timestamp, offset + 4);
  return data;
}

export function verifyProof(input: ProofInput): ProofResult {
  try {
    if (
      !/^[0-9]{1,19}$/.test(input.timestamp) ||
      !Number.isSafeInteger(input.nowMs) ||
      !input.accessToken ||
      !/^https?:\/\//i.test(input.url) ||
      (!input.proof && !input.oldProof)
    )
      return { valid: false, refreshRecommended: false, reason: "malformed" };
    const timestamp = BigInt(input.timestamp);
    if (timestamp > MAX_TICKS)
      return { valid: false, refreshRecommended: false, reason: "malformed" };
    const now = BigInt(input.nowMs) * 10000n + EPOCH_TICKS;
    if (timestamp < now - 20n * 60n * 10000000n || timestamp > now + 5n * 60n * 10000000n) {
      return { valid: false, refreshRecommended: false, reason: "timestamp" };
    }
    const proof = input.proof === undefined ? undefined : decodeBase64(input.proof);
    const oldProof = input.oldProof === undefined ? undefined : decodeBase64(input.oldProof);
    const currentKey = importProofKey(input.keys.current);
    const oldKey = input.keys.old === undefined ? undefined : importProofKey(input.keys.old);
    const expected = buildExpectedProof(input.accessToken, input.url, timestamp);
    if (proof && verify("RSA-SHA256", expected, currentKey, proof)) {
      return { valid: true, refreshRecommended: false };
    }
    // Never accept old proof with old key. Both accepted rotation cases merit refresh.
    if (
      (oldProof && verify("RSA-SHA256", expected, currentKey, oldProof)) ||
      (proof && oldKey && verify("RSA-SHA256", expected, oldKey, proof))
    )
      return { valid: true, refreshRecommended: true };
    return { valid: false, refreshRecommended: true, reason: "signature" };
  } catch {
    return { valid: false, refreshRecommended: false, reason: "malformed" };
  }
}
