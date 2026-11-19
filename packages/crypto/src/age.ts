import { AGE_HEADER_PREFIX } from "@fdrive/contracts";
import { base64 } from "@scure/base";
import {
  Decrypter,
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
  type ReadableStreamWithSize,
} from "age-encryption";

/** An age X25519 identity (`AGE-SECRET-KEY-1…`) and its recipient (`age1…`). */
export interface KeyPair {
  readonly identity: string;
  readonly recipient: string;
}

/** A key, password or age file that does not open what it was given. */
export class DecryptError extends Error {
  override readonly name = "DecryptError";
}

/** The scrypt work factor age uses by default; tests pass a lower one. */
export const DEFAULT_SCRYPT_WORK_FACTOR = 18;

const IDENTITY_PATTERN = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;

export async function newKeyPair(): Promise<KeyPair> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** Whether text is an age X25519 identity, such as a pasted recovery key. */
export function isIdentity(text: string): boolean {
  return IDENTITY_PATTERN.test(text);
}

export async function recipientOf(identity: string): Promise<string> {
  return identityToRecipient(identity);
}

/** Encrypts text to one recipient as an age file, base64. */
export async function sealToRecipient(text: string, recipient: string): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return base64.encode(await encrypter.encrypt(text));
}

/** Opens an age file made by {@link sealToRecipient}. */
export async function openWithIdentity(sealed: string, identity: string): Promise<string> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return openSealed(decrypter, sealed);
}

/** Encrypts text with a password (age's scrypt recipient) as an age file, base64. */
export async function sealWithPassword(
  text: string,
  password: string,
  workFactor = DEFAULT_SCRYPT_WORK_FACTOR,
): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.setScryptWorkFactor(workFactor);
  encrypter.setPassphrase(password);
  return base64.encode(await encrypter.encrypt(text));
}

/** Opens an age file made by {@link sealWithPassword}. */
export async function openWithPassword(sealed: string, password: string): Promise<string> {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(password);
  return openSealed(decrypter, sealed);
}

async function openSealed(decrypter: Decrypter, sealed: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(sealed);
  } catch {
    throw new DecryptError("not base64");
  }
  try {
    return await decrypter.decrypt(bytes, "text");
  } catch (error) {
    throw new DecryptError("cannot decrypt", { cause: error });
  }
}

/** Encrypts a file's bytes to a folder's recipient as they stream. */
export async function encryptStream(
  stream: ReadableStream<Uint8Array>,
  recipient: string,
): Promise<ReadableStreamWithSize> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(stream);
}

/**
 * Decrypts a file's bytes as they stream. The returned promise rejects with a
 * {@link DecryptError} when the header does not open; a damaged body errors the stream.
 */
export async function decryptStream(
  stream: ReadableStream<Uint8Array>,
  identity: string,
): Promise<ReadableStreamWithSize> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  try {
    return await decrypter.decrypt(stream);
  } catch (error) {
    throw new DecryptError("cannot decrypt", { cause: error });
  }
}

const CHUNK = 64 * 1024;
const TAG = 16;
/** The header of an age file with one X25519 recipient, plus the 16-byte payload nonce. */
const X25519_HEADER = 168 + 16;

/** The size of a file encrypted to one X25519 recipient. */
export function encryptedSize(plaintextSize: number): number {
  const chunks = plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / CHUNK);
  return X25519_HEADER + plaintextSize + chunks * TAG;
}

/** The plaintext size of a file encrypted to one X25519 recipient; null when it cannot be one. */
export function decryptedSize(ciphertextSize: number): number | null {
  const payload = ciphertextSize - X25519_HEADER;
  if (payload < TAG) return null;
  const chunks = Math.ceil(payload / (CHUNK + TAG));
  const size = payload - chunks * TAG;
  if (size < 0 || encryptedSize(size) !== ciphertextSize) return null;
  return size;
}

const HEADER_BYTES = new TextEncoder().encode(AGE_HEADER_PREFIX);

/** Whether bytes start the way every age file does. */
export function startsWithAgeHeader(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES.length) return false;
  return HEADER_BYTES.every((byte, index) => bytes[index] === byte);
}
