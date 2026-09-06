import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The credential key id fdrive currently seals every secret under. */
export const KEY_ID = "master-v1";

const VERSION = 0x01;
const WRAP_IV_LENGTH = 12;
const WRAPPED_KEY_LENGTH = 32;
const WRAP_TAG_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH =
  1 + WRAP_IV_LENGTH + WRAPPED_KEY_LENGTH + WRAP_TAG_LENGTH + IV_LENGTH + TAG_LENGTH;

/**
 * Raised by `parseMasterKey` and `open` for every failure mode: a
 * malformed master key, an unsupported envelope version, a truncated blob,
 * or a GCM authentication failure (tamper, wrong key, or wrong AAD).
 */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

/**
 * Decodes a base64-encoded master key, requiring it to decode to exactly
 * 32 bytes (an AES-256 key). Throws `CryptoError` otherwise.
 */
export function parseMasterKey(base64: string): Uint8Array {
  const decoded = Buffer.from(base64, "base64");
  if (decoded.length !== 32) {
    throw new CryptoError(`master key must decode to 32 bytes, got ${decoded.length}`);
  }
  return new Uint8Array(decoded);
}

/**
 * Envelope-encrypts `plaintext` under a fresh random 32-byte data key,
 * itself wrapped with AES-256-GCM under `master`. `aad` (the identity id)
 * authenticates both layers, so a sealed blob cannot be unsealed under a
 * different identity even with the right master key.
 *
 * Wire format: `0x01 | wrapIv(12) | wrappedKey(32) | wrapTag(16) | iv(12) |
 * tag(16) | ciphertext`.
 */
export function seal(master: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  const masterKey = Buffer.from(master);
  const aadBuffer = Buffer.from(aad, "utf8");
  const dataKey = randomBytes(32);
  const wrapIv = randomBytes(WRAP_IV_LENGTH);

  const wrapCipher = createCipheriv("aes-256-gcm", masterKey, wrapIv);
  wrapCipher.setAAD(aadBuffer);
  const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(aadBuffer);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();

  return new Uint8Array(
    Buffer.concat([Buffer.from([VERSION]), wrapIv, wrappedKey, wrapTag, iv, tag, ciphertext]),
  );
}

/**
 * Reverses `seal`: unwraps the data key under `master`, then decrypts the
 * ciphertext under the data key, both authenticated against `aad`. Throws
 * `CryptoError` when the blob is too short to contain the fixed-length
 * header, when its version byte does not match, or when either GCM
 * authentication check fails (tamper, wrong master key, or wrong aad).
 */
export function open(master: Uint8Array, blob: Uint8Array, aad: string): Uint8Array {
  if (blob.length < HEADER_LENGTH) {
    throw new CryptoError(
      `sealed blob is truncated: expected at least ${HEADER_LENGTH} bytes, got ${blob.length}`,
    );
  }

  const buffer = Buffer.from(blob);
  let offset = 0;

  const version = buffer[offset];
  offset += 1;
  if (version !== VERSION) {
    throw new CryptoError(`unsupported envelope version: ${String(version)}`);
  }

  const wrapIv = buffer.subarray(offset, offset + WRAP_IV_LENGTH);
  offset += WRAP_IV_LENGTH;
  const wrappedKey = buffer.subarray(offset, offset + WRAPPED_KEY_LENGTH);
  offset += WRAPPED_KEY_LENGTH;
  const wrapTag = buffer.subarray(offset, offset + WRAP_TAG_LENGTH);
  offset += WRAP_TAG_LENGTH;
  const iv = buffer.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const tag = buffer.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const ciphertext = buffer.subarray(offset);

  const masterKey = Buffer.from(master);
  const aadBuffer = Buffer.from(aad, "utf8");

  let dataKey: Buffer;
  try {
    const wrapDecipher = createDecipheriv("aes-256-gcm", masterKey, wrapIv);
    wrapDecipher.setAAD(aadBuffer);
    wrapDecipher.setAuthTag(wrapTag);
    dataKey = Buffer.concat([wrapDecipher.update(wrappedKey), wrapDecipher.final()]);
  } catch {
    throw new CryptoError("failed to authenticate sealed blob: wrong key, aad, or tampered data");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
    decipher.setAAD(aadBuffer);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new CryptoError("failed to authenticate sealed blob: wrong key, aad, or tampered data");
  }
}
