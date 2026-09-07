import { Readable } from "node:stream";
import { createGzip, createZstdCompress } from "node:zlib";
import * as tar from "tar-stream";
import { describe, expect, it } from "vitest";
import { collectTarPeekEntries, tarCompressionFor } from "./peek-tar.js";
import { webStreamFromNodeReadable } from "./stream-utils.js";

interface TarEntrySpec {
  readonly name: string;
  readonly content?: string;
  readonly type?: "file" | "symlink" | "directory";
  readonly mtime?: Date;
}

function buildTarBuffer(entries: readonly TarEntrySpec[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);

    for (const entry of entries) {
      if (entry.type === "directory") {
        pack.entry({ name: entry.name, type: "directory", mtime: entry.mtime }).end();
        continue;
      }
      if (entry.type === "symlink") {
        pack.entry({ name: entry.name, type: "symlink", linkname: "target" }).end();
        continue;
      }
      const content = entry.content ?? "";
      pack.entry(
        { name: entry.name, size: Buffer.byteLength(content), mtime: entry.mtime },
        content,
      );
    }
    pack.finalize();
  });
}

function bodyOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return webStreamFromNodeReadable(Readable.from(buffer));
}

async function gzipBuffer(buffer: Buffer): Promise<Buffer> {
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  gzip.end(buffer);
  await done;
  return Buffer.concat(chunks);
}

async function zstdBuffer(buffer: Buffer): Promise<Buffer> {
  const zstd = createZstdCompress();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zstd.on("data", (chunk: Buffer) => chunks.push(chunk));
    zstd.on("end", resolve);
    zstd.on("error", reject);
  });
  zstd.end(buffer);
  await done;
  return Buffer.concat(chunks);
}

describe("tarCompressionFor", () => {
  it("maps tar to no decompression", () => {
    expect(tarCompressionFor("tar")).toBe("none");
  });

  it("maps tar.gz to gzip", () => {
    expect(tarCompressionFor("tar.gz")).toBe("gzip");
  });

  it("maps tar.zst to zstd", () => {
    expect(tarCompressionFor("tar.zst")).toBe("zstd");
  });

  it("returns null for a kind it does not handle", () => {
    expect(tarCompressionFor("zip")).toBeNull();
    expect(tarCompressionFor("gz")).toBeNull();
  });
});

describe("collectTarPeekEntries: plain tar", () => {
  it("collects file and directory entries, skipping symlinks", async () => {
    const mtime = new Date(2026, 0, 1, 12, 0, 0);
    const tarBuffer = await buildTarBuffer([
      { name: "a.txt", content: "alpha", mtime },
      { name: "dir", type: "directory", mtime },
      { name: "broken-link", type: "symlink" },
    ]);

    const result = await collectTarPeekEntries(bodyOf(tarBuffer), "none", 10 * 1024 * 1024, 5000);

    expect(result.truncated).toBe(false);
    expect(result.entries).toEqual([
      { path: "a.txt", kind: "file", size: 5, modifiedAt: mtime },
      { path: "dir", kind: "dir", size: 0, modifiedAt: mtime },
    ]);
  });

  it("returns no entries for an empty tar", async () => {
    const tarBuffer = await buildTarBuffer([]);
    const result = await collectTarPeekEntries(bodyOf(tarBuffer), "none", 10 * 1024 * 1024, 5000);
    expect(result).toEqual({ entries: [], truncated: false });
  });

  it("stops at exactly maxEntries without marking truncated when there is nothing more", async () => {
    const tarBuffer = await buildTarBuffer([{ name: "a.txt", content: "x" }]);
    const result = await collectTarPeekEntries(bodyOf(tarBuffer), "none", 10 * 1024 * 1024, 1);
    expect(result).toEqual({
      entries: [{ path: "a.txt", kind: "file", size: 1, modifiedAt: expect.any(Date) }],
      truncated: false,
    });
  });

  it("stops early and reports truncated once more than maxEntries relevant entries exist", async () => {
    const tarBuffer = await buildTarBuffer([
      { name: "a.txt", content: "1" },
      { name: "b.txt", content: "2" },
      { name: "c.txt", content: "3" },
    ]);

    const result = await collectTarPeekEntries(bodyOf(tarBuffer), "none", 10 * 1024 * 1024, 2);

    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("stops early and reports truncated once more than maxBytes have been read", async () => {
    const tarBuffer = await buildTarBuffer([
      { name: "a.txt", content: "x".repeat(2000) },
      { name: "b.txt", content: "y".repeat(2000) },
      { name: "c.txt", content: "z".repeat(2000) },
    ]);

    const result = await collectTarPeekEntries(bodyOf(tarBuffer), "none", 1024, 5000);

    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThan(3);
  });

  it("rejects when the tar stream is corrupt", async () => {
    const garbage = Buffer.from(
      "this is not a tar file at all, just plain garbage bytes".repeat(20),
    );
    await expect(
      collectTarPeekEntries(bodyOf(garbage), "none", 10 * 1024 * 1024, 5000),
    ).rejects.toThrow();
  });
});

describe("collectTarPeekEntries: gzip and zstd", () => {
  it("reads entries from a gzip-compressed tar", async () => {
    const tarBuffer = await buildTarBuffer([{ name: "a.txt", content: "alpha" }]);
    const gzipped = await gzipBuffer(tarBuffer);

    const result = await collectTarPeekEntries(bodyOf(gzipped), "gzip", 10 * 1024 * 1024, 5000);

    expect(result).toEqual({
      entries: [{ path: "a.txt", kind: "file", size: 5, modifiedAt: expect.any(Date) }],
      truncated: false,
    });
  });

  it("reads entries from a zstd-compressed tar", async () => {
    const tarBuffer = await buildTarBuffer([{ name: "a.txt", content: "alpha" }]);
    const compressed = await zstdBuffer(tarBuffer);

    const result = await collectTarPeekEntries(bodyOf(compressed), "zstd", 10 * 1024 * 1024, 5000);

    expect(result).toEqual({
      entries: [{ path: "a.txt", kind: "file", size: 5, modifiedAt: expect.any(Date) }],
      truncated: false,
    });
  });

  it("rejects when a gzip stream is corrupt", async () => {
    const notGzip = Buffer.from("definitely not gzip data".repeat(20));
    await expect(
      collectTarPeekEntries(bodyOf(notGzip), "gzip", 10 * 1024 * 1024, 5000),
    ).rejects.toThrow();
  });
});

describe("collectTarPeekEntries: source stream failure", () => {
  it("rejects when the underlying download stream errors", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("network blip"));
      },
    });

    await expect(collectTarPeekEntries(failing, "none", 10 * 1024 * 1024, 5000)).rejects.toThrow();
  });
});
