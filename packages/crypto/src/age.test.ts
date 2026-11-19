import { describe, expect, it } from "vitest";
import {
  DecryptError,
  decryptedSize,
  decryptStream,
  encryptedSize,
  encryptStream,
  isIdentity,
  newKeyPair,
  openWithIdentity,
  openWithPassword,
  recipientOf,
  sealToRecipient,
  sealWithPassword,
  startsWithAgeHeader,
} from "./age.ts";

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}

function streamOf(bytes: Uint8Array, piece = 10_000): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + piece));
      offset += piece;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("age keys and sealed text", () => {
  it("makes X25519 key pairs", async () => {
    const pair = await newKeyPair();
    expect(isIdentity(pair.identity)).toBe(true);
    expect(pair.recipient).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
    expect(await recipientOf(pair.identity)).toBe(pair.recipient);
    expect(isIdentity("AGE-SECRET-KEY-1")).toBe(false);
  });

  it("seals text to a recipient and opens it only with its identity", async () => {
    const pair = await newKeyPair();
    const other = await newKeyPair();
    const sealed = await sealToRecipient("hello", pair.recipient);
    expect(await openWithIdentity(sealed, pair.identity)).toBe("hello");
    await expect(openWithIdentity(sealed, other.identity)).rejects.toBeInstanceOf(DecryptError);
    await expect(openWithIdentity("@@@", pair.identity)).rejects.toBeInstanceOf(DecryptError);
  });

  it("seals text with a password", async () => {
    const sealed = await sealWithPassword("secret", "correct horse", 10);
    expect(await openWithPassword(sealed, "correct horse")).toBe("secret");
    await expect(openWithPassword(sealed, "wrong")).rejects.toBeInstanceOf(DecryptError);
  });

  it("keeps what failed as the cause", async () => {
    const pair = await newKeyPair();
    const other = await newKeyPair();
    const sealed = await sealToRecipient("x", pair.recipient);
    const error = await openWithIdentity(sealed, other.identity).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecryptError);
    expect((error as DecryptError).cause).toBeInstanceOf(Error);
  });
});

describe("age file streams", () => {
  it.each([0, 1, 65_535, 65_536, 65_537, 200_000])(
    "round-trips %i bytes and predicts the encrypted size",
    async (length) => {
      const pair = await newKeyPair();
      const plain = pattern(length);
      const encrypted = await collect(await encryptStream(streamOf(plain), pair.recipient));
      expect(encrypted.length).toBe(encryptedSize(length));
      expect(decryptedSize(encrypted.length)).toBe(length);
      expect(startsWithAgeHeader(encrypted)).toBe(true);
      const decrypted = await collect(await decryptStream(streamOf(encrypted), pair.identity));
      expect(decrypted).toEqual(plain);
    },
  );

  it("refuses a stream for another identity", async () => {
    const pair = await newKeyPair();
    const other = await newKeyPair();
    const encrypted = await collect(await encryptStream(streamOf(pattern(10)), pair.recipient));
    await expect(decryptStream(streamOf(encrypted), other.identity)).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("refuses sizes no age file to one recipient has", () => {
    expect(decryptedSize(0)).toBeNull();
    expect(decryptedSize(encryptedSize(0) - 1)).toBeNull();
    expect(decryptedSize(encryptedSize(65_536) + 1)).toBeNull();
  });

  it("recognizes the age header", () => {
    expect(startsWithAgeHeader(new TextEncoder().encode("age-encryption.org/v1\n-> X"))).toBe(true);
    expect(startsWithAgeHeader(new TextEncoder().encode("age-encryption.org/v2\n-> X"))).toBe(
      false,
    );
    expect(startsWithAgeHeader(new TextEncoder().encode("age"))).toBe(false);
  });
});
