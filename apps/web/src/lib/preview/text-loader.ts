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
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to load ${url}: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const truncated = bytes.length > opts.limit;
  const slice = truncated ? bytes.subarray(0, opts.limit) : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);

  return { text, truncated };
}
