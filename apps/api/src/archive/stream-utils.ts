import { Readable, Transform } from "node:stream";
import { createZstdCompress, createZstdDecompress } from "node:zlib";

/** True when this Node runtime supports `tar.zst` (Node 22.15+ ships `zlib.createZstd*`). */
export function isZstdSupported(): boolean {
  return typeof createZstdCompress === "function" && typeof createZstdDecompress === "function";
}

/** Thrown when a job's `AbortSignal` was aborted mid-run. */
export class JobAbortedError extends Error {
  constructor() {
    super("job was cancelled");
    this.name = "JobAbortedError";
  }
}

/** Thrown when a job would read more than its configured byte cap. */
export class ByteCapExceededError extends Error {
  constructor(maxBytes: number) {
    super(`exceeded the maximum of ${maxBytes} bytes allowed for this job`);
    this.name = "ByteCapExceededError";
  }
}

/** Throws `JobAbortedError` when `signal` has already been aborted. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new JobAbortedError();
  }
}

/** Converts a `StorageProvider.download` body into a Node `Readable`. */
export function nodeReadableFromWeb(stream: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(stream);
}

/** Converts a Node `Readable` into the web `ReadableStream` `storage.upload` accepts. */
export function webStreamFromNodeReadable(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

/**
 * Builds a passthrough `Transform` that calls `onChunk` with each chunk's
 * byte length as data flows through it, unchanged. Used to track bytes read
 * for job progress and the byte cap without altering the data.
 */
export function countingTransform(onChunk: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onChunk(chunk.length);
      callback(null, chunk);
    },
  });
}

/**
 * Wires a byte counter onto `source`: every chunk increments a running
 * total (reported through `onBytes` with the new running total) and, once
 * the total exceeds `maxBytes`, destroys `source` with a
 * `ByteCapExceededError` so the job fails instead of writing unboundedly.
 * Returns the running total accessor is unnecessary; callers observe totals
 * through `onBytes`.
 */
export function enforceByteCap(
  source: Readable,
  maxBytes: number,
  onBytes: (totalBytes: number) => void,
): void {
  let total = 0;
  source.on("data", (chunk: Buffer) => {
    total += chunk.length;
    onBytes(total);
    if (total > maxBytes) {
      source.destroy(new ByteCapExceededError(maxBytes));
    }
  });
}

/** Extensions whose contents are already compressed, so zip should store rather than deflate them. */
const PRECOMPRESSED_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".zst",
  ".7z",
  ".rar",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp3",
  ".mp4",
  ".m4a",
  ".mov",
  ".webm",
  ".ogg",
  ".heic",
]);

/** True when `entryName`'s extension is already compressed and should be stored, not deflated. */
export function isPrecompressedEntry(entryName: string): boolean {
  const lower = entryName.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  if (lastDot < 0) {
    return false;
  }
  return PRECOMPRESSED_EXTENSIONS.has(lower.slice(lastDot));
}
