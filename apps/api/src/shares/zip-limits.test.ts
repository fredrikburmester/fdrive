import { describe, expect, it, vi } from "vitest";
import {
  createShareZipSlots,
  guardZipStream,
  ShareZipTimeoutError,
  ShareZipTooLargeError,
} from "./zip-limits.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A source that hands out `chunks` one per pull and records how it was stopped. */
function source(chunks: readonly string[], options: { failAfter?: number } = {}) {
  const cancel = vi.fn();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && index >= options.failAfter) {
        controller.error(new Error("disk went away"));
        return;
      }
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(bytes(chunk));
    },
    cancel,
  });
  return { stream, cancel };
}

async function read(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text, error: undefined };
      text += new TextDecoder().decode(value);
    }
  } catch (error) {
    return { text, error };
  }
}

describe("guardZipStream", () => {
  it("passes the archive through and reports its end once", async () => {
    const { stream } = source(["PK", "rest"]);
    const done = vi.fn();
    const guarded = guardZipStream(stream, {
      maxBytes: 6,
      signal: new AbortController().signal,
      done,
    });
    expect(await read(guarded)).toEqual({ text: "PKrest", error: undefined });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("cuts the archive off in error past its byte ceiling and stops the source", async () => {
    const { stream, cancel } = source(["12345", "67890", "x"]);
    const done = vi.fn();
    const guarded = guardZipStream(stream, {
      maxBytes: 8,
      signal: new AbortController().signal,
      done,
    });
    const { text, error } = await read(guarded);
    expect(text).toBe("12345");
    expect(error).toBeInstanceOf(ShareZipTooLargeError);
    expect(cancel).toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("ends in error when the signal aborts, before or while it streams", async () => {
    const before = new AbortController();
    before.abort(new ShareZipTimeoutError());
    const early = source(["a"]);
    const doneEarly = vi.fn();
    const refused = guardZipStream(early.stream, {
      maxBytes: 10,
      signal: before.signal,
      done: doneEarly,
    });
    expect((await read(refused)).error).toBeInstanceOf(ShareZipTimeoutError);
    expect(early.cancel).toHaveBeenCalled();
    expect(doneEarly).toHaveBeenCalledTimes(1);

    const during = new AbortController();
    const late = source(["a", "b", "c"]);
    const done = vi.fn();
    const guarded = guardZipStream(late.stream, { maxBytes: 10, signal: during.signal, done });
    const reader = guarded.getReader();
    expect((await reader.read()).value).toEqual(bytes("a"));
    during.abort(new Error("visitor left"));
    await expect(reader.read()).rejects.toThrow("visitor left");
    expect(late.cancel).toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("drops a read still in flight when the signal aborts", async () => {
    const cancel = vi.fn();
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel,
    });
    const signal = new AbortController();
    const done = vi.fn();
    const reader = guardZipStream(stalled, {
      maxBytes: 10,
      signal: signal.signal,
      done,
    }).getReader();
    const pending = reader.read();
    await new Promise((resolve) => setImmediate(resolve));
    signal.abort(new Error("visitor left"));
    await expect(pending).rejects.toThrow("visitor left");
    expect(cancel).toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("stops the source when the visitor cancels, and reports it once", async () => {
    const { stream, cancel } = source(["a", "b"]);
    const signal = new AbortController();
    const done = vi.fn();
    const guarded = guardZipStream(stream, { maxBytes: 10, signal: signal.signal, done });
    await guarded.cancel("gone");
    expect(cancel).toHaveBeenCalledWith("gone");
    signal.abort();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("passes a failing source on as an error", async () => {
    const { stream } = source(["a"], { failAfter: 1 });
    const done = vi.fn();
    const guarded = guardZipStream(stream, {
      maxBytes: 10,
      signal: new AbortController().signal,
      done,
    });
    const { text, error } = await read(guarded);
    expect(text).toBe("a");
    expect(error).toEqual(new Error("disk went away"));
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("createShareZipSlots", () => {
  it("counts streaming archives per share and frees a slot once", () => {
    const slots = createShareZipSlots(2);
    const first = slots.acquire("a");
    const second = slots.acquire("a");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(slots.acquire("a")).toBeNull();
    expect(slots.acquire("b")).not.toBeNull();
    first?.();
    first?.();
    const third = slots.acquire("a");
    expect(third).not.toBeNull();
    expect(slots.acquire("a")).toBeNull();
    second?.();
    third?.();
    const fourth = slots.acquire("a");
    expect(fourth).not.toBeNull();
    // A stale release of an emptied share does not free a slot taken since.
    third?.();
    expect(slots.acquire("a")).not.toBeNull();
    expect(slots.acquire("a")).toBeNull();
    fourth?.();
  });
});
