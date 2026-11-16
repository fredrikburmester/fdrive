import { decryptStream, encryptStream } from "@fdrive/crypto";

/** Files up to this size open in the viewer; larger ones download instead. */
export const PREVIEW_LIMIT = 500 * 1024 * 1024;
/** The largest file the browser decrypts; anything larger opens only in FDrive for Mac. */
export const BROWSER_LIMIT = 2 * 1024 * 1024 * 1024;

/** A file's bytes as an age file to a folder's recipient, ready to upload. */
export async function encryptBlob(file: Blob, recipient: string): Promise<Blob> {
  return new Response(await encryptStream(file.stream(), recipient)).blob();
}

/** Bytes as they arrive from fdrive: from a download, or from a file already in memory. */
export async function readBody(response: Response): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok || response.body === null) {
    throw new Error(`The file could not be read (${response.status}).`);
  }
  return response.body;
}

/** A downloaded age file, decrypted with a folder's identity, typed as `type`. */
export async function decryptResponse(
  response: Response,
  identity: string,
  type = "",
): Promise<Blob> {
  const plain = await new Response(await decryptStream(await readBody(response), identity)).blob();
  return type === "" ? plain : new Blob([plain], { type });
}

/** Fetches and decrypts a file of an encrypted folder. */
export async function fetchDecrypted(
  url: string,
  identity: string,
  type = "",
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Blob> {
  return decryptResponse(await fetchImpl(url, { credentials: "same-origin" }), identity, type);
}

/** Why the browser will not decrypt a file of `size` bytes, or null when it will. */
export function tooLargeToDecrypt(size: number): string | null {
  return size > BROWSER_LIMIT
    ? "This file is too large to open in the browser. Open it in FDrive for Mac."
    : null;
}
