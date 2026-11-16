import { isEncryptedName, MAX_ENCRYPTED_NAME_BYTES } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { newKeyPair } from "./age.ts";
import { encodeBase32 } from "./base32.ts";
import {
  checkName,
  decryptName,
  encryptName,
  InvalidNameError,
  identityScalar,
  NameTooLongError,
  nameKey,
  nameKeyBytes,
} from "./names.ts";

const FOLDER = "2f1b8f3e-8c55-4d2b-9a57-1d3b6f0c2a11";

async function folderKey(): Promise<CryptoKey> {
  return nameKey((await newKeyPair()).identity);
}

describe("encrypted names", () => {
  it("round-trips a name and stores it in the shape the server accepts", async () => {
    const key = await folderKey();
    const stored = await encryptName("Kvitton 2026.pdf", key, FOLDER);
    expect(isEncryptedName(stored)).toBe(true);
    expect(stored).toBe(stored.toLowerCase());
    expect(await decryptName(stored, key, FOLDER)).toBe("Kvitton 2026.pdf");
  });

  it("stores names in NFC, so macOS's decomposed accents match typed ones", async () => {
    const key = await folderKey();
    const stored = await encryptName("Möte.txt", key, FOLDER);
    expect(await decryptName(stored, key, FOLDER)).toBe("Möte.txt");
  });

  it("encrypts the same name differently each time", async () => {
    const key = await folderKey();
    expect(await encryptName("a", key, FOLDER)).not.toBe(await encryptName("a", key, FOLDER));
  });

  it("fits the longest allowed name in a 255-byte file name", async () => {
    const key = await folderKey();
    const longest = "å".repeat(MAX_ENCRYPTED_NAME_BYTES / 2);
    const stored = await encryptName(longest, key, FOLDER);
    expect(stored.length).toBeLessThanOrEqual(255);
    expect(isEncryptedName(stored)).toBe(true);
    expect(await decryptName(stored, key, FOLDER)).toBe(longest);
  });

  it("refuses names it cannot hold", () => {
    expect(() => checkName("")).toThrow(InvalidNameError);
    expect(() => checkName(".")).toThrow(InvalidNameError);
    expect(() => checkName("..")).toThrow(InvalidNameError);
    expect(() => checkName("a/b")).toThrow(InvalidNameError);
    expect(() => checkName("a\0b")).toThrow(InvalidNameError);
    expect(() => checkName("x".repeat(MAX_ENCRYPTED_NAME_BYTES + 1))).toThrow(NameTooLongError);
    expect(checkName("x".repeat(MAX_ENCRYPTED_NAME_BYTES))).toHaveLength(MAX_ENCRYPTED_NAME_BYTES);
  });

  it("does not decrypt with another folder's key or id", async () => {
    const key = await folderKey();
    const stored = await encryptName("a", key, FOLDER);
    expect(await decryptName(stored, await folderKey(), FOLDER)).toBeNull();
    expect(await decryptName(stored, key, crypto.randomUUID())).toBeNull();
  });

  it("does not decrypt names that are not encrypted names", async () => {
    const key = await folderKey();
    expect(await decryptName("photo.jpg", key, FOLDER)).toBeNull();
    // A one-byte name is 29 bytes, 47 characters with three spare bits; "b" sets one.
    const stored = await encryptName("a", key, FOLDER);
    expect(await decryptName(`${stored.slice(0, -1)}b`, key, FOLDER)).toBeNull();
  });

  it("does not decrypt a name that is not UTF-8", async () => {
    const identity = (await newKeyPair()).identity;
    const raw = await crypto.subtle.importKey(
      "raw",
      await nameKeyBytes(identity),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const nonce = new Uint8Array(12);
    const sealed = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(`fdrive/name/v1:${FOLDER}`),
      },
      raw,
      new Uint8Array([0xff, 0xfe]),
    );
    const stored = `fe1-${encodeBase32(new Uint8Array([...nonce, ...new Uint8Array(sealed)]))}`;
    expect(await decryptName(stored, await nameKey(identity), FOLDER)).toBeNull();
  });

  it("encrypts deterministically with a given nonce, for test vectors", async () => {
    const key = await folderKey();
    const nonce = new Uint8Array(12).fill(7);
    expect(await encryptName("a", key, FOLDER, nonce)).toBe(
      await encryptName("a", key, FOLDER, nonce),
    );
  });

  it("reads an identity's scalar and refuses anything else", async () => {
    const pair = await newKeyPair();
    expect(identityScalar(pair.identity)).toHaveLength(32);
    expect(() => identityScalar(pair.recipient)).toThrow(InvalidNameError);
  });
});
