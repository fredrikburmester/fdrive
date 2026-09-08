import { describe, expect, it } from "vitest";
import { DEFAULT_PROBE_MAX_BYTES, probeDirectoryStream } from "./directory-probe.js";

function makeStream(
  chunks: readonly (Uint8Array | string)[],
  opts?: {
    cancelError?: unknown;
    hasCancelError?: boolean;
    readErrorAfterChunk?: number;
    readErrorValue?: unknown;
    hasReadError?: boolean;
  },
) {
  let pulled = 0;
  let cancelled = false;
  let cancelReason: unknown;
  const encoder = new TextEncoder();
  const byteChunks = chunks.map((c) => (typeof c === "string" ? encoder.encode(c) : c));

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts?.readErrorAfterChunk !== undefined && pulled >= opts.readErrorAfterChunk) {
        controller.error(opts.hasReadError ? opts.readErrorValue : new Error("Stream read failed"));
        return;
      }
      if (pulled < byteChunks.length) {
        const chunk = byteChunks[pulled];
        if (chunk !== undefined) {
          controller.enqueue(chunk);
          pulled++;
        }
      } else {
        controller.close();
      }
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      if (opts?.hasCancelError) {
        throw opts.cancelError;
      }
    },
  });

  return {
    stream,
    get pulledCount() {
      return pulled;
    },
    get isCancelled() {
      return cancelled;
    },
    get cancelReason() {
      return cancelReason;
    },
  };
}

describe("probeDirectoryStream", () => {
  it("accepts an empty array", async () => {
    const s = makeStream(["[]"]);
    await expect(probeDirectoryStream(s.stream)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
  });

  it("accepts an empty array with leading and trailing whitespace", async () => {
    const s = makeStream(["  \t\r\n[  \r\n\t  ]  \r\n"]);
    await expect(probeDirectoryStream(s.stream)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
  });

  it("accepts a single valid object entry", async () => {
    const s = makeStream(['[{"name": "file.txt", "size": 123}]']);
    await expect(probeDirectoryStream(s.stream)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
  });

  it("cancels multi-entry stream after first entry without draining remainder", async () => {
    const s = makeStream([
      '[{"name": "file1.txt"}',
      ',{"name": "file2.txt"}',
      ',{"name": "file3.txt"}]',
    ]);
    await expect(probeDirectoryStream(s.stream)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
    expect(s.pulledCount).toBeLessThan(3);
  });

  it("handles tokens split across chunk boundaries", async () => {
    const s = makeStream(["[", " { ", '"na', 'me": ', '"hello"', " } ", "]"]);
    await expect(probeDirectoryStream(s.stream)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
  });

  it("handles 2-byte and 4-byte UTF-8 characters split across chunks", async () => {
    const encoder = new TextEncoder();
    // 'café' has 'é' as [0xc3, 0xa9]
    const cafePrefix = encoder.encode('[{"name": "caf');
    const splitByte1 = new Uint8Array([0xc3]);
    const splitByte2 = new Uint8Array([0xa9]);
    // '🚀' is [0xf0, 0x9f, 0x9a, 0x80]
    const splitRocket1 = new Uint8Array([0xf0, 0x9f]);
    const splitRocket2 = new Uint8Array([0x9a, 0x80]);
    const suffix = encoder.encode('"}]');

    const s = makeStream([
      cafePrefix,
      splitByte1,
      splitByte2,
      encoder.encode('", "icon": "'),
      splitRocket1,
      splitRocket2,
      suffix,
    ]);

    await expect(probeDirectoryStream(s.stream)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
  });

  it("handles escaped quotes, escaped backslashes, and braces inside strings", async () => {
    const json = JSON.stringify([
      {
        path: 'C:\\Users\\"alice"\\{special}',
        nested: "foo\\}bar",
      },
      { second: 2 },
    ]);
    const s = makeStream([json]);
    await expect(probeDirectoryStream(s.stream)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
  });

  it("handles nested objects and arrays in the first entry", async () => {
    const json = JSON.stringify([
      {
        name: "folder",
        metadata: {
          tags: ["a", "b", { id: 1 }],
          stats: { count: 10 },
        },
      },
    ]);
    const s = makeStream([json]);
    await expect(probeDirectoryStream(s.stream)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
  });

  it("rejects non-array JSON roots", async () => {
    const s1 = makeStream(['{"error": "not an array"}']);
    await expect(probeDirectoryStream(s1.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Invalid directory stream: expected array",
    });

    const s2 = makeStream(["123"]);
    await expect(probeDirectoryStream(s2.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Invalid directory stream: expected array",
    });

    const s3 = makeStream(['"string"']);
    await expect(probeDirectoryStream(s3.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Invalid directory stream: expected array",
    });
  });

  it("rejects scalar elements in the array", async () => {
    const s1 = makeStream(["[1, 2, 3]"]);
    await expect(probeDirectoryStream(s1.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Invalid directory stream: expected entry object or end of array",
    });

    const s2 = makeStream(['["string"]']);
    await expect(probeDirectoryStream(s2.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Invalid directory stream: expected entry object or end of array",
    });

    const s3 = makeStream(["[null]"]);
    await expect(probeDirectoryStream(s3.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Invalid directory stream: expected entry object or end of array",
    });
  });

  it("rejects malformed JSON within the first entry", async () => {
    const s = makeStream(['[{name: "unquoted"}]']);
    await expect(probeDirectoryStream(s.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Invalid directory stream: first entry is malformed",
    });
  });

  it("rejects truncated streams that end unexpectedly", async () => {
    const s1 = makeStream([""]);
    await expect(probeDirectoryStream(s1.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Directory stream ended unexpectedly",
    });

    const s2 = makeStream(["["]);
    await expect(probeDirectoryStream(s2.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Directory stream ended unexpectedly",
    });

    const s3 = makeStream(['[{"name": "incomplete"']);
    await expect(probeDirectoryStream(s3.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Directory stream ended unexpectedly",
    });
  });

  it("surfaces stream read errors as server SftpgoError", async () => {
    const s = makeStream(['[{"name": "partial"'], { readErrorAfterChunk: 1 });
    await expect(probeDirectoryStream(s.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Stream read failed",
    });
  });

  it("rejects when prefix budget limit is exceeded", async () => {
    const s = makeStream([
      '[{"name": "this is a very long entry that exceeds the prefix limit of 30 bytes"}]',
    ]);
    await expect(probeDirectoryStream(s.stream, 30)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Directory probe exceeded maximum prefix limit",
    });
  });

  it("rejects immediately when maxBytes <= 0", async () => {
    const s = makeStream(['[{"name": "a"}]']);
    await expect(probeDirectoryStream(s.stream, 0)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Directory probe exceeded maximum prefix limit",
    });
  });

  it("succeeds on oversized chunk when first entry fits within prefix budget", async () => {
    // 128 KiB chunk, first entry is small
    const firstEntry = '[{"name": "small"}]';
    const padding = ",".repeat(128 * 1024);
    const chunk = new TextEncoder().encode(firstEntry + padding);

    const s = makeStream([chunk]);
    await expect(probeDirectoryStream(s.stream, DEFAULT_PROBE_MAX_BYTES)).resolves.toBeUndefined();
    expect(s.isCancelled).toBe(true);
  });

  it("surfaces cancel failure as server SftpgoError while releasing lock", async () => {
    const cancelError = new Error("Underlying cancel failed");
    const s = makeStream(['[{"name": "first"}]'], { hasCancelError: true, cancelError });

    await expect(probeDirectoryStream(s.stream)).rejects.toMatchObject({
      name: "SftpgoError",
      kind: "server",
      message: "Underlying cancel failed",
    });
    // Stream reader lock should have been released in finally
    expect(() => s.stream.getReader()).not.toThrow();
  });

  it("surfaces falsy cancel rejections (undefined, false) as server SftpgoError and releases lock", async () => {
    for (const cancelValue of [undefined, false]) {
      const s = makeStream(['[{"name": "first"}]'], {
        hasCancelError: true,
        cancelError: cancelValue,
      });

      await expect(probeDirectoryStream(s.stream)).rejects.toMatchObject({
        name: "SftpgoError",
        kind: "server",
      });
      expect(() => s.stream.getReader()).not.toThrow();
    }
  });

  it("surfaces falsy stream read errors (null, undefined, false) as server SftpgoError and releases lock", async () => {
    for (const readErrorValue of [null, undefined, false]) {
      const s = makeStream(['[{"name": "first"'], {
        readErrorAfterChunk: 1,
        hasReadError: true,
        readErrorValue,
      });

      await expect(probeDirectoryStream(s.stream)).rejects.toMatchObject({
        name: "SftpgoError",
        kind: "server",
      });
      expect(() => s.stream.getReader()).not.toThrow();
    }
  });
});
