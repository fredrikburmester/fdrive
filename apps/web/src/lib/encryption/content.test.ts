import { newKeyPair, startsWithAgeHeader } from "@fdrive/crypto";
import { describe, expect, it } from "vitest";
import { bytesOf } from "@/test-fixtures/encryption";
import {
  BROWSER_LIMIT,
  decryptResponse,
  encryptBlob,
  fetchDecrypted,
  PREVIEW_LIMIT,
  readBody,
  tooLargeToDecrypt,
} from "./content";

describe("encrypted content", () => {
  it("encrypts a file to a folder's recipient and decrypts it back, typed", async () => {
    const pair = await newKeyPair();
    const cipher = await encryptBlob(new Blob(["hello"]), pair.recipient);
    expect(startsWithAgeHeader(new Uint8Array(await cipher.arrayBuffer()))).toBe(true);
    const plain = await decryptResponse(new Response(cipher), pair.identity, "text/plain");
    expect(plain.type).toBe("text/plain");
    expect(await bytesOf(plain)).toBe("hello");
    const untyped = await decryptResponse(new Response(cipher), pair.identity);
    expect(untyped.type).toBe("");
  });

  it("fetches and decrypts, with the session's cookies", async () => {
    const pair = await newKeyPair();
    const cipher = await encryptBlob(new Blob(["fetched"]), pair.recipient);
    const asked: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      asked.push(init);
      return new Response(cipher);
    }) as unknown as typeof fetch;
    const blob = await fetchDecrypted("/f", pair.identity, "", fetchImpl);
    expect(await bytesOf(blob)).toBe("fetched");
    expect(asked[0]?.credentials).toBe("same-origin");
  });

  it("refuses a failed download", async () => {
    await expect(readBody(new Response("no", { status: 404 }))).rejects.toThrow("404");
    await expect(readBody(new Response(null))).rejects.toThrow("could not be read");
  });

  it("says when a file is too large for the browser", () => {
    expect(PREVIEW_LIMIT).toBeLessThan(BROWSER_LIMIT);
    expect(tooLargeToDecrypt(BROWSER_LIMIT)).toBeNull();
    expect(tooLargeToDecrypt(BROWSER_LIMIT + 1)).toContain("FDrive for Mac");
  });
});
