import { boundedBody } from "./bounded-body";
import { HEIC_EXTENSIONS } from "./kind";

/**
 * Cap on HEIC bytes fetched and decoded client-side: 50 MiB. Larger files are
 * refused before a byte is downloaded (when the size is known) or as soon as
 * the response declares or exceeds the limit, so the decoder never sees an
 * unbounded blob.
 */
export const MAX_HEIC_DECODE_BYTES = 50 * 1024 * 1024;

const MAX_HEIC_DECODE_MIB = MAX_HEIC_DECODE_BYTES / (1024 * 1024);
const TOO_LARGE = `HEIC image exceeds ${MAX_HEIC_DECODE_MIB} MiB decode limit`;

/** True when `ext` (case-insensitive, with leading dot) is a HEIC or HEIF extension. */
export function isHeicExt(ext: string): boolean {
  return HEIC_EXTENSIONS.has(ext.toLowerCase());
}

export interface DecodeHeicOptions {
  readonly signal?: AbortSignal;
}

/**
 * Decodes a HEIC/HEIF blob into a JPEG blob via `heic-to/csp`. That bundle is
 * a wasm2js build: it runs the decoder as plain JavaScript in a blob worker,
 * so it needs neither `'unsafe-eval'` nor `'wasm-unsafe-eval'` in the CSP.
 * JPEG at quality 0.92 keeps the result far smaller than a raw PNG.
 */
export async function decodeHeicBlob(blob: Blob, options?: DecodeHeicOptions): Promise<Blob> {
  if (blob.size > MAX_HEIC_DECODE_BYTES) throw new Error(TOO_LARGE);
  options?.signal?.throwIfAborted();
  const { heicTo } = await import("heic-to/csp");
  options?.signal?.throwIfAborted();
  const result = await heicTo({ blob, type: "image/jpeg", quality: 0.92 });
  options?.signal?.throwIfAborted();
  return result;
}

export interface FetchHeicOptions extends DecodeHeicOptions {
  /** The file's known size, when the caller has it: over the cap, nothing is fetched. */
  readonly size?: number | undefined;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Fetches a HEIC/HEIF file and decodes it to JPEG, enforcing
 * `MAX_HEIC_DECODE_BYTES` before the download starts (known `size`), on the
 * response's `Content-Length`, and while streaming the body.
 */
export async function fetchHeicAsJpeg(src: string, options: FetchHeicOptions = {}): Promise<Blob> {
  if (options.size !== undefined && options.size > MAX_HEIC_DECODE_BYTES) {
    throw new Error(TOO_LARGE);
  }
  const signal = options.signal ?? new AbortController().signal;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(src, { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error(`Failed to load file: HTTP ${response.status}`);
  const blob = await boundedBody(response, MAX_HEIC_DECODE_BYTES, signal, TOO_LARGE);
  return decodeHeicBlob(blob, { signal });
}
