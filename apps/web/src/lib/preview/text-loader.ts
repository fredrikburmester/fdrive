export interface LoadTextOptions {
  /** Maximum number of bytes to decode; anything beyond is dropped. */
  readonly limit: number;
}

export interface LoadTextResult {
  readonly text: string;
  /** True when the response body was larger than `opts.limit` bytes. */
  readonly truncated: boolean;
}

/**
 * Fetches `url` and decodes its body as UTF-8 text, reading at most
 * `opts.limit` bytes. Takes the `fetch` implementation as an argument so it
 * can be unit tested with a stub. Throws when the response is not ok.
 */
export async function loadText(
  url: string,
  fetchImpl: typeof fetch,
  opts: LoadTextOptions,
): Promise<LoadTextResult> {
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 0) throw new Error("invalid text limit");
  const response = await fetchImpl(url);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`failed to load ${url}: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = opts.limit - size;
      chunks.push(value.slice(0, remaining));
      size += Math.min(remaining, value.byteLength);
      if (value.byteLength > remaining) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}
