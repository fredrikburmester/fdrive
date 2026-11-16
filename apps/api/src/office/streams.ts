import { WopiError } from "./errors.ts";

/** What a bounded stream let through, and why it stopped early, if it did. */
export interface BoundedProgress {
  size: number;
  failure?: unknown;
}

/**
 * `source` with at most `maxBytes`: past the limit it fails with 413, and on
 * `signal` with 408. `progress` follows it, so a caller whose consumer wraps
 * the failure (a storage upload) can still answer with the request's own.
 */
export function boundedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  progress: BoundedProgress = { size: 0 },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  function cleanup() {
    signal.removeEventListener("abort", abort);
  }
  function abort() {
    if (stopped) return;
    stopped = true;
    cleanup();
    progress.failure = new WopiError(408);
    controller.error(progress.failure);
    void reader.cancel().catch(() => undefined);
  }
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(c) {
      try {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) {
          stopped = true;
          cleanup();
          c.close();
          reader.releaseLock();
          return;
        }
        progress.size += next.value.byteLength;
        if (progress.size > maxBytes) throw new WopiError(413);
        c.enqueue(next.value);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          cleanup();
          progress.failure = error;
          c.error(error);
          void reader.cancel().catch(() => undefined);
        }
      }
    },
    async cancel(reason) {
      stopped = true;
      cleanup();
      await reader.cancel(reason);
    },
  });
}
