import type { DownloadOptions, DownloadResult, SftpgoPublicShareApi } from "@fdrive/sftpgo";
import { describe, expect, it, vi } from "vitest";
import { UnreadableArchiveError } from "../archive/peek.ts";
import { createSharePeekPort, parseContentRangeTotal } from "./peek-adapter.ts";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function download(over: Partial<DownloadResult>): DownloadResult {
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

function fakeApi(overrides: Partial<SftpgoPublicShareApi> = {}): SftpgoPublicShareApi {
  return {
    downloadFile: vi.fn(async () => download({})),
    list: vi.fn(async () => []),
    download: vi.fn(async () => download({})),
    zip: vi.fn(async () => streamOf(new Uint8Array())),
    upload: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("createSharePeekPort", () => {
  it("routes download through downloadFile for a single-file share", async () => {
    const api = fakeApi();
    const port = createSharePeekPort({ api, isSingleFile: true });
    await port.download("/", { range: { start: 0, end: 3 } });
    expect(api.downloadFile).toHaveBeenCalledWith({ range: { start: 0, end: 3 } });
    expect(api.download).not.toHaveBeenCalled();
  });

  it("routes download through download(path) for a directory share", async () => {
    const api = fakeApi();
    const port = createSharePeekPort({ api, isSingleFile: false });
    await port.download("/docs.zip");
    expect(api.download).toHaveBeenCalledWith("/docs.zip", {});
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it("forwards an abort signal to the underlying call", async () => {
    const controller = new AbortController();
    const api = fakeApi();
    const port = createSharePeekPort({ api, isSingleFile: false });
    await port.download("/docs.zip", { signal: controller.signal });
    expect(api.download).toHaveBeenCalledWith("/docs.zip", { signal: controller.signal });
  });

  it("statFile reads the total size off a 206 suffix-range response", async () => {
    const api = fakeApi({
      download: vi.fn(async (_path: string, options?: DownloadOptions) => {
        expect(options?.rangeHeader).toBe("bytes=-65536");
        return download({ status: 206, contentRange: "bytes 65472-65535/65536" });
      }),
    });
    const port = createSharePeekPort({ api, isSingleFile: false });
    const stat = await port.statFile("/docs.zip");
    expect(stat.size).toBe(65536);
  });

  it("statFile throws when a 206 response has an unparsable Content-Range", async () => {
    const api = fakeApi({
      download: vi.fn(async () => download({ status: 206, contentRange: null })),
    });
    const port = createSharePeekPort({ api, isSingleFile: false });
    await expect(port.statFile("/docs.zip")).rejects.toBeInstanceOf(UnreadableArchiveError);
  });

  it("statFile falls back to a whole 200 body under the size ceiling", async () => {
    const api = fakeApi({
      downloadFile: vi.fn(async () => download({ status: 200, contentLength: 1024 })),
    });
    const port = createSharePeekPort({ api, isSingleFile: true });
    const stat = await port.statFile("/");
    expect(stat.size).toBe(1024);
  });

  it("statFile rejects a 200 fallback over the size ceiling", async () => {
    const api = fakeApi({
      downloadFile: vi.fn(async () => download({ status: 200, contentLength: 64 * 1024 * 1024 })),
    });
    const port = createSharePeekPort({ api, isSingleFile: true });
    await expect(port.statFile("/")).rejects.toBeInstanceOf(UnreadableArchiveError);
  });

  it("statFile rejects a 200 fallback with no Content-Length", async () => {
    const api = fakeApi({
      downloadFile: vi.fn(async () => download({ status: 200, contentLength: null })),
    });
    const port = createSharePeekPort({ api, isSingleFile: true });
    await expect(port.statFile("/")).rejects.toBeInstanceOf(UnreadableArchiveError);
  });

  it("statFile discards the response body instead of reading it", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const api = fakeApi({
      downloadFile: vi.fn(async () => download({ status: 200, contentLength: 10, body })),
    });
    const port = createSharePeekPort({ api, isSingleFile: true });
    await port.statFile("/");
    expect(cancel).toHaveBeenCalled();
  });
});
