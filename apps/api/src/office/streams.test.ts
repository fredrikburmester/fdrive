import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../test/fixtures/memory-storage.js";
import { boundedStream, contentVersion, withStagedUpload } from "./streams.ts";

describe("bounded office streams", () => {
  it("streams at the exact cap and hashes bytes without buffering files", async () => {
    const storage = createMemoryStorage({ "/a": "hello" });
    const result = await contentVersion(storage, "/a", 5, new AbortController().signal);
    expect(result.size).toBe(5);
    expect(result.version).toBe("0:5:2cf24dba5fb0a30e");
    await expect(
      contentVersion(storage, "/a", 4, new AbortController().signal),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("cancels pending reads on abort and ignores repeated aborts", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const reader = boundedStream(new ReadableStream({ cancel }), 5, abort.signal).getReader();
    const read = reader.read();
    abort.abort();
    abort.abort();
    await expect(read).rejects.toMatchObject({ status: 408 });
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
    const stream = boundedStream(new ReadableStream({ cancel }), 5, new AbortController().signal);
    await stream.cancel("closed");
    expect(cancel).toHaveBeenCalledWith("closed");
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

describe("private staged uploads", () => {
  it("stages complete bounded bytes on private disk and cleans up after success or failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-stage-test-"));
    const signal = new AbortController().signal;
    try {
      const result = await withStagedUpload(
        new Response("hello").body as ReadableStream<Uint8Array>,
        5,
        signal,
        async (body, size) => {
          expect(size).toBe(5);
          const directories = await readdir(root);
          expect(directories).toHaveLength(1);
          const directory = join(root, directories[0] ?? "missing");
          expect((await stat(directory)).mode & 0o777).toBe(0o700);
          expect((await stat(join(directory, "upload"))).mode & 0o777).toBe(0o600);
          return new Response(body).text();
        },
        root,
      );
      expect(result).toBe("hello");
      expect(await readdir(root)).toEqual([]);
      const consume = vi.fn(async () => {
        throw new Error("upstream failed");
      });
      await expect(
        withStagedUpload(
          new Response("hello").body as ReadableStream<Uint8Array>,
          5,
          signal,
          consume,
          root,
        ),
      ).rejects.toThrow("upstream failed");
      expect(await readdir(root)).toEqual([]);
      consume.mockClear();
      await expect(
        withStagedUpload(
          new Response("too large").body as ReadableStream<Uint8Array>,
          5,
          signal,
          consume,
          root,
        ),
      ).rejects.toMatchObject({ status: 413 });
      expect(consume).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
      const abort = new AbortController();
      abort.abort();
      await expect(
        withStagedUpload(
          new Response("hello").body as ReadableStream<Uint8Array>,
          5,
          abort.signal,
          consume,
          root,
        ),
      ).rejects.toMatchObject({ status: 408 });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
