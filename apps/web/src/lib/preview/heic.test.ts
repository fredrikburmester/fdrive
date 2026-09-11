import { describe, expect, it, vi } from "vitest";
import { decodeHeicBlob, fetchHeicAsJpeg, isHeicExt, MAX_HEIC_DECODE_BYTES } from "./heic";

interface MockHeicToOptions {
  blob: Blob;
  type: string;
  quality?: number;
}

const mockHeicTo = vi.fn(async (options: MockHeicToOptions) => {
  return new Blob(["fake-jpeg-bytes"], { type: options.type });
});

vi.mock("heic-to/csp", () => ({
  heicTo: (options: MockHeicToOptions) => mockHeicTo(options),
}));

describe("isHeicExt", () => {
  it("identifies .heic and .heif extensions case-insensitively", () => {
    expect(isHeicExt(".heic")).toBe(true);
    expect(isHeicExt(".heif")).toBe(true);
    expect(isHeicExt(".HEIC")).toBe(true);
    expect(isHeicExt(".HEIF")).toBe(true);
  });

  it("returns false for non-HEIC extensions", () => {
    expect(isHeicExt(".jpg")).toBe(false);
    expect(isHeicExt(".png")).toBe(false);
    expect(isHeicExt(".webp")).toBe(false);
    expect(isHeicExt("")).toBe(false);
  });
});

describe("decodeHeicBlob", () => {
  it("decodes a HEIC blob to JPEG at quality 0.92 via heic-to/csp", async () => {
    mockHeicTo.mockClear();
    const inputBlob = new Blob(["fake-heic-bytes"], { type: "image/heic" });
    const result = await decodeHeicBlob(inputBlob);

    expect(mockHeicTo).toHaveBeenCalledWith({ blob: inputBlob, type: "image/jpeg", quality: 0.92 });
    expect(result.type).toBe("image/jpeg");
  });

  it("rejects blobs exceeding MAX_HEIC_DECODE_BYTES before invoking the decoder", async () => {
    mockHeicTo.mockClear();
    const largeBlob = { size: MAX_HEIC_DECODE_BYTES + 1, type: "image/heic" } as unknown as Blob;

    await expect(decodeHeicBlob(largeBlob)).rejects.toThrow("exceeds 50 MiB decode limit");
    expect(mockHeicTo).not.toHaveBeenCalled();
  });

  it("respects an already aborted signal", async () => {
    mockHeicTo.mockClear();
    const inputBlob = new Blob(["fake-heic-bytes"], { type: "image/heic" });
    const controller = new AbortController();
    controller.abort();

    await expect(decodeHeicBlob(inputBlob, { signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    );
    expect(mockHeicTo).not.toHaveBeenCalled();
  });
});

describe("fetchHeicAsJpeg", () => {
  function fakeFetch(body: string, init: ResponseInit = {}) {
    return vi.fn(async () => new Response(body, { status: 200, ...init }));
  }

  it("refuses a file whose known size exceeds the cap without fetching", async () => {
    mockHeicTo.mockClear();
    const fetchImpl = fakeFetch("x");

    await expect(
      fetchHeicAsJpeg("/file.heic", { size: MAX_HEIC_DECODE_BYTES + 1, fetchImpl }),
    ).rejects.toThrow("exceeds 50 MiB decode limit");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockHeicTo).not.toHaveBeenCalled();
  });

  it("refuses on Content-Length before buffering the body", async () => {
    mockHeicTo.mockClear();
    const fetchImpl = fakeFetch("x", {
      headers: { "content-length": String(MAX_HEIC_DECODE_BYTES + 1) },
    });

    await expect(fetchHeicAsJpeg("/file.heic", { fetchImpl })).rejects.toThrow(
      "exceeds 50 MiB decode limit",
    );
    expect(mockHeicTo).not.toHaveBeenCalled();
  });

  it("surfaces a failed response as an error", async () => {
    const fetchImpl = fakeFetch("missing", { status: 404 });

    await expect(fetchHeicAsJpeg("/file.heic", { fetchImpl })).rejects.toThrow("HTTP 404");
  });

  it("fetches with same-origin credentials and decodes the body", async () => {
    mockHeicTo.mockClear();
    const fetchImpl = fakeFetch("fake-heic-bytes");

    const result = await fetchHeicAsJpeg("/file.heic", { size: 15, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/file.heic",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(mockHeicTo).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("image/jpeg");
  });
});
