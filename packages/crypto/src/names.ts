import {
  ENCRYPTED_NAME_PREFIX,
  isEncryptedName,
  MAX_ENCRYPTED_NAME_BYTES,
} from "@fdrive/contracts";
import { bech32 } from "@scure/base";
import { decodeBase32, encodeBase32 } from "./base32.ts";

/** A name an encrypted folder cannot hold. */
export class InvalidNameError extends Error {
  override readonly name = "InvalidNameError";
}

/** A name longer than {@link MAX_ENCRYPTED_NAME_BYTES} once encoded as UTF-8. */
export class NameTooLongError extends InvalidNameError {}

const NAME_KEY_INFO = new Uint8Array(new TextEncoder().encode("fdrive/name-key/v1"));
const NONCE_BYTES = 12;

/** The raw 32-byte X25519 scalar of an age identity. */
export function identityScalar(identity: string): Uint8Array<ArrayBuffer> {
  const { prefix, bytes } = bech32.decodeToBytes(identity.toLowerCase());
  if (prefix !== "age-secret-key-" || bytes.length !== 32) {
    throw new InvalidNameError("not an age X25519 identity");
  }
  return new Uint8Array(bytes);
}

/** The 32 bytes of a folder's name key: HKDF-SHA-256 over its identity's scalar. */
export async function nameKeyBytes(folderIdentity: string): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", identityScalar(folderIdentity), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: NAME_KEY_INFO },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** The AES-256-GCM key a folder's names are encrypted with. */
export async function nameKey(folderIdentity: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await nameKeyBytes(folderIdentity), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function associatedData(folderId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`fdrive/name/v1:${folderId}`));
}

/** A name as an encrypted folder stores it: NFC, one path segment, at most 128 UTF-8 bytes. */
export function checkName(name: string): string {
  const normalized = name.normalize("NFC");
  if (normalized === "" || normalized === "." || normalized === "..") {
    throw new InvalidNameError("a name cannot be empty, . or ..");
  }
  if (normalized.includes("/") || normalized.includes("\0")) {
    throw new InvalidNameError("a name cannot contain / or a null character");
  }
  if (new TextEncoder().encode(normalized).length > MAX_ENCRYPTED_NAME_BYTES) {
    throw new NameTooLongError(
      `names in an encrypted folder are limited to ${MAX_ENCRYPTED_NAME_BYTES} bytes`,
    );
  }
  return normalized;
}

/** Encrypts a name for an encrypted folder. `nonce` is for test vectors only. */
export async function encryptName(
  name: string,
  key: CryptoKey,
  folderId: string,
  nonce: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
): Promise<string> {
  const plaintext = new Uint8Array(new TextEncoder().encode(checkName(name)));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: associatedData(folderId) },
    key,
    plaintext,
  );
  const bytes = new Uint8Array(NONCE_BYTES + sealed.byteLength);
  bytes.set(nonce);
  bytes.set(new Uint8Array(sealed), NONCE_BYTES);
  return ENCRYPTED_NAME_PREFIX + encodeBase32(bytes);
}

/** Decrypts a stored name; null when it is not one this folder's key made. */
export async function decryptName(
  stored: string,
  key: CryptoKey,
  folderId: string,
): Promise<string | null> {
  if (!isEncryptedName(stored)) return null;
  const bytes = decodeBase32(stored.slice(ENCRYPTED_NAME_PREFIX.length));
  if (bytes === null) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, NONCE_BYTES),
        additionalData: associatedData(folderId),
      },
      key,
      bytes.slice(NONCE_BYTES),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return null;
  }
}
