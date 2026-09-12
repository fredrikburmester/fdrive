import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import * as tar from "tar-stream";
import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { peekArchive, UnreadableArchiveError, UnsupportedPeekFormatError } from "./peek.js";

/**
 * A `StorageProvider` backed by an in-memory map of path -> bytes, honoring
 * `download`'s `range` option (unlike the shared `memory-storage.ts`
 * fixture, which always returns the whole file): the zip route depends on
 * a real Range read only returning the requested slice.
 */
function createRangeAwareStorage(files: Record<string, Buffer>): StorageProvider {
  function notImplemented(): never {
    throw new Error("not implemented in this fixture");
  }

  return {
    list: notImplemented,
    stat: notImplemented,
    async statFile(path: string) {
      const content = files[path];
      if (content === undefined) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      return { size: content.length, modifiedAt: null, contentType: null };
    },
    async download(path: string, opts?: { range?: { start: number; end?: number } }) {
      const content = files[path];
      if (content === undefined) {
        throw new StorageError("not_found", `not found: ${path}`);
      }
      const range = opts?.range;
      const start = range?.start ?? 0;
      const end = range?.end ?? content.length - 1;
      const slice = content.subarray(start, end + 1);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(slice);
          controller.close();
        },
      });
      return {
        status: (range !== undefined ? 206 : 200) as 200 | 206,
        body,
        contentLength: slice.length,
        contentRange: range === undefined ? null : `bytes ${start}-${end}/${content.length}`,
        contentType: null,
        lastModified: null,
      };
    },
    upload: notImplemented,
    mkdir: notImplemented,
    move: notImplemented,
    copy: notImplemented,
    deleteFile: notImplemented,
    deleteDir: notImplemented,
    setModifiedAt: notImplemented,
    zip: notImplemented,
  };
}

async function buildZipBuffer(build: (zipfile: ZipFile) => void): Promise<Buffer> {
  const zipfile = new ZipFile();
  build(zipfile);
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on("end", resolve);
    zipfile.outputStream.on("error", reject);
  });
  zipfile.end();
  await done;
  return Buffer.concat(chunks);
}

function buildTarBuffer(entries: readonly { name: string; content: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
    for (const entry of entries) {
      pack.entry({ name: entry.name, size: Buffer.byteLength(entry.content) }, entry.content);
    }
    pack.finalize();
  });
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

describe("peekArchive: unsupported and non-archive paths", () => {
  it("throws UnsupportedPeekFormatError for a path with no archive extension", async () => {
    const storage = createRangeAwareStorage({});
    await expect(
      peekArchive({ storage, path: "/notes.txt", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnsupportedPeekFormatError);
  });

  it("throws UnsupportedPeekFormatError for a bare .gz (not a listable archive)", async () => {
    const storage = createRangeAwareStorage({});
    await expect(
      peekArchive({ storage, path: "/notes.txt.gz", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnsupportedPeekFormatError);
  });
});

describe("peekArchive: zip", () => {
  it("reads entries via two Range reads, sorted by path", async () => {
    const mtime = new Date(2026, 0, 1);
    const zipBytes = await buildZipBuffer((zipfile) => {
      zipfile.addBuffer(Buffer.from("bravo"), "b.txt", { mtime });
      zipfile.addBuffer(Buffer.from("alpha"), "a.txt", { mtime });
    });
    const storage = createRangeAwareStorage({ "/archive.zip": zipBytes });

    const result = await peekArchive({
      storage,
      path: "/archive.zip",
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result.format).toBe("zip");
    expect(result.truncated).toBe(false);
    expect(result.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("truncates a zip with more than 5000 entries", async () => {
    const zipBytes = await buildZipBuffer((zipfile) => {
      for (let i = 0; i < 5001; i++) {
        zipfile.addBuffer(Buffer.alloc(0), `f${String(i).padStart(5, "0")}.txt`);
      }
    });
    const storage = createRangeAwareStorage({ "/many.zip": zipBytes });

    const result = await peekArchive({ storage, path: "/many.zip", maxBytes: DEFAULT_MAX_BYTES });

    expect(result.entries).toHaveLength(5000);
    expect(result.truncated).toBe(true);
    // The 5001-entry zip is fast alone but has taken seconds under a full
    // coverage run, so give it the same headroom as the route-level test.
  }, 20_000);

  it("returns no entries for an empty zip without a second Range read", async () => {
    const zipBytes = await buildZipBuffer(() => {});
    const storage = createRangeAwareStorage({ "/empty.zip": zipBytes });

    const result = await peekArchive({ storage, path: "/empty.zip", maxBytes: DEFAULT_MAX_BYTES });

    expect(result).toEqual({ format: "zip", entries: [], truncated: false });
  });

  it("refuses a zip whose end record declares an oversized or out-of-file central directory", async () => {
    const zipBytes = await buildZipBuffer((zipfile) => {
      zipfile.addBuffer(Buffer.from("x"), "a.txt");
    });
    // The end-of-central-directory record starts with 0x06054b50; its central directory
    // size lives 12 bytes in. Declare a size far beyond the file.
    const eocd = zipBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);
    const oversized = Buffer.from(zipBytes);
    oversized.writeUInt32LE(0xfffffff0, eocd + 12);
    const storage = createRangeAwareStorage({ "/huge.zip": oversized });
    await expect(
      peekArchive({ storage, path: "/huge.zip", maxBytes: 1024 * 1024 }),
    ).rejects.toBeInstanceOf(UnreadableArchiveError);
  });

  it("throws UnreadableArchiveError for an empty file", async () => {
    const storage = createRangeAwareStorage({ "/empty.zip": Buffer.alloc(0) });
    await expect(
      peekArchive({ storage, path: "/empty.zip", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnreadableArchiveError);
  });

  it("throws UnreadableArchiveError for a file with no valid end-of-central-directory record", async () => {
    const storage = createRangeAwareStorage({ "/not-a-zip.zip": Buffer.alloc(100) });
    await expect(
      peekArchive({ storage, path: "/not-a-zip.zip", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnreadableArchiveError);
  });

  it("throws UnreadableArchiveError for a central directory that fails to parse", async () => {
    // A well-formed EOCD pointing at a central directory region that is not
    // actually central directory records (the file is otherwise all zero).
    const buffer = Buffer.alloc(200);
    const eocdOffset = buffer.length - 22;
    buffer.writeUInt32LE(0x06054b50, eocdOffset);
    buffer.writeUInt16LE(1, eocdOffset + 10); // 1 entry
    buffer.writeUInt32LE(50, eocdOffset + 12); // central directory size
    buffer.writeUInt32LE(0, eocdOffset + 16); // central directory offset
    const storage = createRangeAwareStorage({ "/corrupt.zip": buffer });

    await expect(
      peekArchive({ storage, path: "/corrupt.zip", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnreadableArchiveError);
  });

  it("propagates a StorageError from the storage layer unchanged", async () => {
    const storage: StorageProvider = {
      ...createRangeAwareStorage({}),
      statFile: async () => {
        throw new StorageError("forbidden", "no access");
      },
    };

    await expect(
      peekArchive({ storage, path: "/secret.zip", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("peekArchive: tar family", () => {
  it("reads entries from a plain tar, sorted by path", async () => {
    const tarBytes = await buildTarBuffer([
      { name: "b.txt", content: "bravo" },
      { name: "a.txt", content: "alpha" },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/docs.tar", tarBytes);

    const result = await peekArchive({ storage, path: "/docs.tar", maxBytes: DEFAULT_MAX_BYTES });

    expect(result.format).toBe("tar");
    expect(result.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
    expect(result.truncated).toBe(false);
  });

  it("throws UnreadableArchiveError for a corrupt tar.gz", async () => {
    const storage = createMemoryStorage();
    await storage.upload("/bad.tar.gz", Buffer.from("not gzip data".repeat(20)));

    await expect(
      peekArchive({ storage, path: "/bad.tar.gz", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnreadableArchiveError);
  });

  it("propagates a not_found StorageError for a missing tar", async () => {
    const storage = createMemoryStorage();
    await expect(
      peekArchive({ storage, path: "/missing.tar", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("throws UnsupportedPeekFormatError for tar.zst when zstdSupported is overridden false", async () => {
    const storage = createMemoryStorage();
    await storage.upload("/docs.tar.zst", Buffer.from("irrelevant"));

    await expect(
      peekArchive({
        storage,
        path: "/docs.tar.zst",
        maxBytes: DEFAULT_MAX_BYTES,
        zstdSupported: false,
      }),
    ).rejects.toThrow(UnsupportedPeekFormatError);
  });
});

it.each(["ignored", "missing-range", "wrong-range", "wrong-length", "overrun", "short"])(
  "bounds ZIP readers when the upstream response is %s",
  async (mode) => {
    let cancelled = false;
    let reads = 0;
    const total = 1024 * 1024;
    const size = 65536;
    const storage = createRangeAwareStorage({ "/large.zip": Buffer.alloc(total) });
    storage.download = async () => ({
      status: mode === "ignored" ? 200 : 206,
      contentRange:
        mode === "missing-range"
          ? null
          : `bytes ${mode === "wrong-range" ? 0 : total - size}-${total - 1}/${total}`,
      contentLength: mode === "wrong-length" ? total : null,
      contentType: null,
      lastModified: null,
      body: new ReadableStream(
        {
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array(mode === "short" ? size - 1 : size + 1));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    });
    await expect(
      peekArchive({ storage, path: "/large.zip", maxBytes: total }),
    ).rejects.toBeInstanceOf(UnreadableArchiveError);
    if (["ignored", "missing-range", "wrong-range", "wrong-length"].includes(mode)) {
      expect(cancelled).toBe(true);
      expect(reads).toBe(0);
    } else {
      expect(reads).toBe(1);
    }
  },
);

it("permits a bounded complete 200 response for a small archive", async () => {
  const bytes = await buildZipBuffer((zip) => zip.addBuffer(Buffer.from("ok"), "ok.txt"));
  const storage = createRangeAwareStorage({ "/small.zip": bytes });
  const download = storage.download;
  let calls = 0;
  storage.download = async (path, options) => {
    const result = await download(path, options);
    return ++calls === 1 ? { ...result, status: 200, contentRange: null } : result;
  };
  expect(
    (await peekArchive({ storage, path: "/small.zip", maxBytes: DEFAULT_MAX_BYTES })).entries[0]
      ?.path,
  ).toBe("ok.txt");
});

it.each([true, false])(
  "rejects unsafe range replies even if cancel fails (invalid headers=%s)",
  async (invalidHeaders) => {
    const bytes = await buildZipBuffer((zip) => zip.addBuffer(Buffer.from("kept"), "a.txt"));
    const storage = createRangeAwareStorage({ "/file.zip": bytes });
    storage.download = async () => ({
      status: invalidHeaders ? 200 : 206,
      contentLength: null,
      contentRange: invalidHeaders ? null : `bytes 0-${bytes.length - 1}/${bytes.length}`,
      contentType: null,
      lastModified: null,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(bytes.length + 1));
        },
        cancel() {
          throw new Error("cancel failed");
        },
      }),
    });
    if (invalidHeaders)
      storage.statFile = async () => ({ size: 100_000, modifiedAt: null, contentType: null });
    await expect(
      peekArchive({ storage, path: "/file.zip", maxBytes: 1_000_000 }),
    ).rejects.toBeInstanceOf(UnreadableArchiveError);
  },
);
