import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ByteCapExceededError,
  countingTransform,
  enforceByteCap,
  isPrecompressedEntry,
  isZstdSupported,
  JobAbortedError,
  nodeReadableFromWeb,
  throwIfAborted,
  webStreamFromNodeReadable,
} from "./stream-utils.js";

describe("throwIfAborted", () => {
  it("does nothing when the signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it("throws JobAbortedError when the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(JobAbortedError);
  });
});

describe("nodeReadableFromWeb / webStreamFromNodeReadable", () => {
  it("round-trips bytes through a web ReadableStream and back", async () => {
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });

    const nodeStream = nodeReadableFromWeb(web);
    const backToWeb = webStreamFromNodeReadable(nodeStream);
    const reader = backToWeb.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(combined.toString("utf8")).toBe("hello");
  });
});

describe("countingTransform", () => {
  it("passes chunks through unchanged while reporting their length", async () => {
    const seen: number[] = [];
    const transform = countingTransform((n) => seen.push(n));
    const source = Readable.from([Buffer.from("ab"), Buffer.from("cde")]);

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      source
        .pipe(transform)
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .on("end", resolve)
        .on("error", reject);
    });

    expect(Buffer.concat(chunks).toString("utf8")).toBe("abcde");
    expect(seen).toEqual([2, 3]);
  });
});

describe("enforceByteCap", () => {
  it("reports the running total for each chunk", async () => {
    const totals: number[] = [];
    const source = Readable.from([Buffer.from("ab"), Buffer.from("cde")]);
    enforceByteCap(source, 1000, (total) => totals.push(total));

    await new Promise<void>((resolve, reject) => {
      source.on("data", () => {});
      source.on("end", resolve);
      source.on("error", reject);
    });

    expect(totals).toEqual([2, 5]);
  });

  it("destroys the source with ByteCapExceededError once the cap is exceeded", async () => {
    const source = Readable.from([Buffer.from("abcdef")]);
    enforceByteCap(source, 3, () => {});

    const error = await new Promise<unknown>((resolve) => {
      source.on("data", () => {});
      source.on("error", resolve);
    });

    expect(error).toBeInstanceOf(ByteCapExceededError);
  });
});

describe("isPrecompressedEntry", () => {
  it.each([".zip", ".jpg", ".png", ".mp4", ".gz"])("treats %s as precompressed", (ext) => {
    expect(isPrecompressedEntry(`photo${ext}`)).toBe(true);
  });

  it.each([".txt", ".md", ".pdf", ".json"])("treats %s as not precompressed", (ext) => {
    expect(isPrecompressedEntry(`doc${ext}`)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPrecompressedEntry("PHOTO.JPG")).toBe(true);
  });

  it("returns false for a name with no extension", () => {
    expect(isPrecompressedEntry("README")).toBe(false);
  });
});

describe("isZstdSupported", () => {
  it("reflects whether node:zlib exposes the zstd functions", () => {
    // This Node runtime (22.15+) supports it; assert the real, unmocked result.
    expect(isZstdSupported()).toBe(true);
  });
});

describe("ByteCapExceededError / JobAbortedError", () => {
  it("carries a descriptive message including the cap", () => {
    const error = new ByteCapExceededError(1024);
    expect(error.message).toContain("1024");
    expect(error.name).toBe("ByteCapExceededError");
  });

  it("JobAbortedError has a fixed message and name", () => {
    const error = new JobAbortedError();
    expect(error.name).toBe("JobAbortedError");
    expect(error.message.length).toBeGreaterThan(0);
  });
});
