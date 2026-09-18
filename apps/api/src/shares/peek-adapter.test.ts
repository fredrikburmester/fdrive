import { describe, expect, it, vi } from "vitest";
import { UnreadableArchiveError } from "../archive/peek.ts";
import type { PublicShareAccess, ShareDownloadOptions, ShareDownloadResult } from "./access.ts";
import { createSharePeekPort, parseContentRangeTotal } from "./peek-adapter.ts";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function download(over: Partial<ShareDownloadResult>): ShareDownloadResult {
  return {
    status: 200,
    body: streamOf(new Uint8Array()),
    contentLength: null,
    contentRange: null,
    contentType: null,
    lastModified: null,
    ...over,
  };
}

describe("parseContentRangeTotal", () => {
  it("parses a well-formed Content-Range header", () => {
    expect(parseContentRangeTotal("bytes 65472-65535/65536")).toBe(65536);
  });

  it("returns null for a missing header", () => {
    expect(parseContentRangeTotal(null)).toBeNull();
  });

  it("returns null for a wildcard total", () => {
    expect(parseContentRangeTotal("bytes 0-9/*")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseContentRangeTotal("not a content range")).toBeNull();
  });
});

function fakeAccess(
  impl: (path: string, options?: ShareDownloadOptions) => Promise<ShareDownloadResult> = async () =>
    download({}),
): Pick<PublicShareAccess, "download"> & { download: ReturnType<typeof vi.fn> } {
  return { download: vi.fn(impl) };
}

describe("createSharePeekPort", () => {
  it("reads a single-file share at / whatever path names its extension", async () => {
    const access = fakeAccess();
    const port = createSharePeekPort({ access, isSingleFile: true });
    await port.download("/folder/docs.zip", { range: { start: 0, end: 3 } });
    expect(access.download).toHaveBeenCalledWith("/", { range: { start: 0, end: 3 } });
  });

  it("reads a directory share at the requested path", async () => {
    const access = fakeAccess();
    const port = createSharePeekPort({ access, isSingleFile: false });
    await port.download("/docs.zip");
    expect(access.download).toHaveBeenCalledWith("/docs.zip", {});
  });

  it("forwards an abort signal to the underlying call", async () => {
    const controller = new AbortController();
    const access = fakeAccess();
    const port = createSharePeekPort({ access, isSingleFile: false });
    await port.download("/docs.zip", { signal: controller.signal });
    expect(access.download).toHaveBeenCalledWith("/docs.zip", { signal: controller.signal });
  });

  it("statFile reads the total size off a 206 suffix-range response", async () => {
    const access = fakeAccess(async (_path, options) => {
      expect(options?.range).toEqual({ suffix: 65536 });
      return download({ status: 206, contentRange: "bytes 65472-65535/65536" });
    });
    const port = createSharePeekPort({ access, isSingleFile: false });
    const stat = await port.statFile("/docs.zip");
    expect(stat.size).toBe(65536);
  });

  it("statFile throws when a 206 response has an unparsable Content-Range", async () => {
    const access = fakeAccess(async () => download({ status: 206, contentRange: null }));
    const port = createSharePeekPort({ access, isSingleFile: false });
    await expect(port.statFile("/docs.zip")).rejects.toBeInstanceOf(UnreadableArchiveError);
  });

  it("statFile falls back to a whole 200 body under the size ceiling", async () => {
    const access = fakeAccess(async () => download({ status: 200, contentLength: 1024 }));
    const port = createSharePeekPort({ access, isSingleFile: true });
    const stat = await port.statFile("/");
    expect(stat.size).toBe(1024);
  });

  it("statFile rejects a 200 fallback over the size ceiling", async () => {
    const access = fakeAccess(async () =>
      download({ status: 200, contentLength: 64 * 1024 * 1024 }),
    );
    const port = createSharePeekPort({ access, isSingleFile: true });
    await expect(port.statFile("/")).rejects.toBeInstanceOf(UnreadableArchiveError);
  });

  it("statFile rejects a 200 fallback with no Content-Length", async () => {
    const access = fakeAccess(async () => download({ status: 200, contentLength: null }));
    const port = createSharePeekPort({ access, isSingleFile: true });
    await expect(port.statFile("/")).rejects.toBeInstanceOf(UnreadableArchiveError);
  });

  it("statFile discards the response body instead of reading it", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const access = fakeAccess(async () => download({ status: 200, contentLength: 10, body }));
    const port = createSharePeekPort({ access, isSingleFile: true });
    await port.statFile("/");
    expect(cancel).toHaveBeenCalled();
  });
});
