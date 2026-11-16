import { describe, expect, it, vi } from "vitest";
import { type BoundedProgress, boundedStream } from "./streams.ts";

describe("bounded office streams", () => {
  it("passes the exact cap, refuses one byte more and keeps why it stopped", async () => {
    const progress: BoundedProgress = { size: 0 };
    const exact = boundedStream(
      new Response("hello").body as ReadableStream<Uint8Array>,
      5,
      new AbortController().signal,
      progress,
    );
    expect(await new Response(exact).text()).toBe("hello");
    expect(progress).toEqual({ size: 5 });
    const over: BoundedProgress = { size: 0 };
    const larger = boundedStream(
      new Response("hello!").body as ReadableStream<Uint8Array>,
      5,
      new AbortController().signal,
      over,
    );
    await expect(new Response(larger).text()).rejects.toMatchObject({ status: 413 });
    expect(over.failure).toMatchObject({ status: 413 });
  });
  it("cancels pending reads on abort and ignores repeated aborts", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const progress: BoundedProgress = { size: 0 };
    const reader = boundedStream(
      new ReadableStream({ cancel }),
      5,
      abort.signal,
      progress,
    ).getReader();
    const read = reader.read();
    abort.abort();
    abort.abort();
    await expect(read).rejects.toMatchObject({ status: 408 });
    expect(progress.failure).toMatchObject({ status: 408 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects already aborted requests and handles cancellation errors", async () => {
    const abort = new AbortController();
    abort.abort();
    const stream = boundedStream(
      new ReadableStream({
        cancel() {
          throw new Error("cancel failed");
        },
      }),
      5,
      abort.signal,
    );
    await expect(new Response(stream).text()).rejects.toMatchObject({ status: 408 });
  });
  it("forwards consumer cancellation and stream errors", async () => {
    const cancel = vi.fn();
    const progress: BoundedProgress = { size: 0 };
    const stream = boundedStream(
      new ReadableStream({ cancel }),
      5,
      new AbortController().signal,
      progress,
    );
    await stream.cancel("closed");
    expect(cancel).toHaveBeenCalledWith("closed");
    // The consumer gave up: the stream itself did not fail.
    expect(progress.failure).toBeUndefined();
    const failing = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("failed"));
      },
    });
    await expect(
      new Response(boundedStream(failing, 5, new AbortController().signal)).text(),
    ).rejects.toThrow("failed");
  });
  it("handles an abort racing an errored read", async () => {
    const abort = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("source"));
        abort.abort();
      },
    });
    await expect(new Response(boundedStream(source, 5, abort.signal)).text()).rejects.toThrow();
  });
});
