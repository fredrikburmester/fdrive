/**
 * Cap on HEIC blob size decoded client-side: 50 MiB. Files exceeding this limit
 * fail fast rather than risking an unbounded memory spike or browser tab crash.
 */
export const MAX_HEIC_DECODE_BYTES = 50 * 1024 * 1024;

/**
 * True when `ext` (case-insensitive, with leading dot) is a HEIC or HEIF extension.
 */
export function isHeicExt(ext: string): boolean {
  const lower = ext.toLowerCase();
  return lower === ".heic" || lower === ".heif";
}

export interface DecodeHeicOptions {
  readonly quality?: number;
  readonly signal?: AbortSignal;
}

/**
 * Decodes a HEIC/HEIF blob into a standard JPEG blob via `heic-to/csp`.
 * Uses the CSP-safe bundle (which avoids `new Function(...)`) and defaults to
 * JPEG at quality 0.92 to prevent the unbounded memory footprint of raw PNGs.
 */
export async function decodeHeicBlob(blob: Blob, options?: DecodeHeicOptions): Promise<Blob> {
  if (blob.size > MAX_HEIC_DECODE_BYTES) {
    throw new Error("HEIC image exceeds 50 MiB decode limit");
  }
  if (options?.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  const { heicTo } = await import("heic-to/csp");
  if (options?.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  const result = await heicTo({
    blob,
    type: "image/jpeg",
    quality: options?.quality ?? 0.92,
  });
  if (options?.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  return result;
}
