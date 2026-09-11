import { describe, expect, it, vi } from "vitest";
import { decodeHeicBlob, isHeicExt, MAX_HEIC_DECODE_BYTES } from "./heic";

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
  it("decodes a valid HEIC blob using heic-to/csp with JPEG quality 0.92", async () => {
    const inputBlob = new Blob(["fake-heic-bytes"], { type: "image/heic" });
    const result = await decodeHeicBlob(inputBlob);

    expect(mockHeicTo).toHaveBeenCalledWith({
      blob: inputBlob,
      type: "image/jpeg",
      quality: 0.92,
    });
    expect(result.type).toBe("image/jpeg");
  });

  it("accepts custom quality setting", async () => {
    const inputBlob = new Blob(["fake-heic-bytes"], { type: "image/heic" });
    await decodeHeicBlob(inputBlob, { quality: 0.8 });

    expect(mockHeicTo).toHaveBeenCalledWith({
      blob: inputBlob,
      type: "image/jpeg",
      quality: 0.8,
    });
  });

  it("rejects blobs exceeding MAX_HEIC_DECODE_BYTES before invoking decoder", async () => {
    mockHeicTo.mockClear();
    const largeBlob = {
      size: MAX_HEIC_DECODE_BYTES + 1,
      type: "image/heic",
    } as unknown as Blob;

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
