/**
 * The ceilings on one public share's archive downloads. A single zip
 * request is one limiter hit but walks the whole shared tree and holds file
 * handles for as long as the visitor reads, so each is bounded in count,
 * time and size.
 */
export interface ShareZipLimits {
  /** Archive downloads of one share that may stream at the same time. */
  readonly perShare: number;
  /** Wall-clock ceiling on one archive response, in milliseconds. */
  readonly timeoutMs: number;
  /** Bytes one archive response may send before it is cut off. */
  readonly maxBytes: number;
}

/**
 * Two at a time per link, an hour each, and the 10 GiB archive jobs are
 * held to (`FDRIVE_JOB_MAX_BYTES`), which the composition passes in.
 */
export const DEFAULT_SHARE_ZIP_LIMITS: ShareZipLimits = {
  perShare: 2,
  timeoutMs: 60 * 60 * 1000,
  maxBytes: 10 * 1024 * 1024 * 1024,
};

/** Thrown into an archive stream that would send more than its byte ceiling. */
export class ShareZipTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`archive exceeds the maximum of ${maxBytes} bytes`);
    this.name = "ShareZipTooLargeError";
  }
}

/** Thrown into an archive stream that ran past its wall-clock ceiling. */
export class ShareZipTimeoutError extends Error {
  constructor() {
    super("archive download took too long");
    this.name = "ShareZipTimeoutError";
  }
}

/**
 * Counts the archive downloads streaming per share. `acquire` takes a slot
 * and returns its release, which is safe to call more than once, or `null`
 * when the share already streams `perShare` of them.
 */
export function createShareZipSlots(perShare: number) {
  const active = new Map<string, Set<object>>();
  return {
    acquire(shareId: string): (() => void) | null {
      const slots = active.get(shareId) ?? new Set<object>();
      if (slots.size >= perShare) return null;
      const slot = {};
      slots.add(slot);
      active.set(shareId, slots);
      return () => {
        slots.delete(slot);
        if (slots.size === 0 && active.get(shareId) === slots) active.delete(shareId);
      };
    },
  };
}
export type ShareZipSlots = ReturnType<typeof createShareZipSlots>;

function ignore(): void {}

/**
 * Streams `source` to a visitor under the archive ceilings: at most
 * `maxBytes`, and only until `signal` aborts (the visitor left, or the
 * wall-clock ceiling passed). Whatever ends the stream, its end, a failure,
 * a cancel, the byte ceiling or the abort, stops the source and calls
 * `done` once. An early end is an error, never a clean close, so a
 * visitor is never handed a truncated archive as a complete one.
 */
export function guardZipStream(
  source: ReadableStream<Uint8Array>,
  opts: { readonly maxBytes: number; readonly signal: AbortSignal; readonly done: () => void },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let sent = 0;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  // Each way the stream ends happens once, and only while it is readable, so
  // `done` runs once; `finished` tells a read still in flight to drop its result.
  function finish(): void {
    finished = true;
    opts.signal.removeEventListener("abort", onAbort);
    opts.done();
  }
  function stop(reason: unknown): void {
    finish();
    controller.error(reason);
    reader.cancel(reason).catch(ignore);
  }
  function onAbort(): void {
    stop(opts.signal.reason);
  }
  return new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull() {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        stop(error);
        return;
      }
      if (finished) return;
      if (chunk.done) {
        finish();
        controller.close();
        return;
      }
      sent += chunk.value.byteLength;
      if (sent > opts.maxBytes) {
        stop(new ShareZipTooLargeError(opts.maxBytes));
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}
