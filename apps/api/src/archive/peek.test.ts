import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenFile, StorageError, type StorageProvider } from "@fdrive/core";
import { createLocalStorage } from "@fdrive/local";
import { createMemoryStorage } from "@fdrive/testkit";
import * as tar from "tar-stream";
import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import {
  PEEK_TAIL_READ_BYTES,
  peekArchive,
  UnreadableArchiveError,
  UnsupportedPeekFormatError,
} from "./peek.js";

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
    const storage = createMemoryStorage({});
    await expect(
      peekArchive({ storage, path: "/notes.txt", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnsupportedPeekFormatError);
  });

  it("throws UnsupportedPeekFormatError for a bare .gz (not a listable archive)", async () => {
    const storage = createMemoryStorage({});
    await expect(
      peekArchive({ storage, path: "/notes.txt.gz", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnsupportedPeekFormatError);
  });
});

describe("peekArchive: zip", () => {
  it("reads entries via two reads by position, sorted by path", async () => {
    const mtime = new Date(2026, 0, 1);
    const zipBytes = await buildZipBuffer((zipfile) => {
      zipfile.addBuffer(Buffer.from("bravo"), "b.txt", { mtime });
      zipfile.addBuffer(Buffer.from("alpha"), "a.txt", { mtime });
    });
    const storage = createMemoryStorage({ "/archive.zip": zipBytes });

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
    const storage = createMemoryStorage({ "/many.zip": zipBytes });

    const result = await peekArchive({ storage, path: "/many.zip", maxBytes: DEFAULT_MAX_BYTES });

    expect(result.entries).toHaveLength(5000);
    expect(result.truncated).toBe(true);
    // The 5001-entry zip is fast alone but has taken seconds under a full
    // coverage run, so give it the same headroom as the route-level test.
  }, 20_000);

  it("returns no entries for an empty zip without a second read", async () => {
    const zipBytes = await buildZipBuffer(() => {});
    const storage = createMemoryStorage({ "/empty.zip": zipBytes });

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
    const storage = createMemoryStorage({ "/huge.zip": oversized });
    await expect(
      peekArchive({ storage, path: "/huge.zip", maxBytes: 1024 * 1024 }),
    ).rejects.toBeInstanceOf(UnreadableArchiveError);
  });

  it("throws UnreadableArchiveError for an empty file", async () => {
    const storage = createMemoryStorage({ "/empty.zip": Buffer.alloc(0) });
    await expect(
      peekArchive({ storage, path: "/empty.zip", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnreadableArchiveError);
  });

  it("throws UnreadableArchiveError for a file with no valid end-of-central-directory record", async () => {
    const storage = createMemoryStorage({ "/not-a-zip.zip": Buffer.alloc(100) });
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
    const storage = createMemoryStorage({ "/corrupt.zip": buffer });

    await expect(
      peekArchive({ storage, path: "/corrupt.zip", maxBytes: DEFAULT_MAX_BYTES }),
    ).rejects.toThrow(UnreadableArchiveError);
  });

  it("propagates a StorageError from the storage layer unchanged", async () => {
    const storage: StorageProvider = {
      ...createMemoryStorage({}),
      open: async () => {
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

/** `storage`, counting the bytes its open files read and whether each was closed. */
function counted(storage: StorageProvider) {
  const seen = { reads: [] as number[], streamed: false, closed: 0, opened: 0 };
  return {
    seen,
    storage: {
      ...storage,
      open: async (path: string): Promise<OpenFile> => {
        const file = await storage.open(path);
        seen.opened++;
        return {
          ...file,
          stream: (start, end) => {
            seen.streamed = true;
            return file.stream(start, end);
          },
          read: async (position, length) => {
            const bytes = await file.read(position, length);
            seen.reads.push(bytes.length);
            return bytes;
          },
          close: async () => {
            seen.closed++;
            await file.close();
          },
        };
      },
    } satisfies StorageProvider,
  };
}

it("peeks a zip whose central directory sits at the end of a large file", async () => {
  const home = await mkdtemp(join(tmpdir(), "fdrive-peek-"));
  try {
    const big = Buffer.alloc(48 * 1024 * 1024, 7);
    const zipBytes = await buildZipBuffer((zipfile) => {
      zipfile.addBuffer(big, "big.bin", { compress: false });
      zipfile.addBuffer(Buffer.from("tail"), "notes/tail.txt");
    });
    expect(zipBytes.length).toBeGreaterThan(big.length);
    await writeFile(join(home, "large.zip"), zipBytes);
    const { storage, seen } = counted(createLocalStorage({ home }));

    const result = await peekArchive({ storage, path: "/large.zip", maxBytes: DEFAULT_MAX_BYTES });

    expect(result.entries.map((entry) => [entry.path, entry.size])).toEqual([
      ["big.bin", big.length],
      ["notes/tail.txt", 4],
    ]);
    // The tail, then the central directory: nothing of the large entry.
    expect(seen.reads).toHaveLength(2);
    expect(seen.reads[0]).toBe(PEEK_TAIL_READ_BYTES);
    expect(seen.reads.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(80 * 1024);
    expect(seen).toMatchObject({ streamed: false, opened: 1, closed: 1 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);

it("refuses a zip that reads short of what its end record declares, and closes it", async () => {
  const bytes = await buildZipBuffer((zip) => zip.addBuffer(Buffer.from("kept"), "a.txt"));
  const memory = createMemoryStorage({ "/file.zip": bytes });
  const storage: StorageProvider = {
    ...memory,
    open: async (path) => {
      const file = await memory.open(path);
      let reads = 0;
      // The tail arrives whole; the central directory comes up one byte short.
      return {
        ...file,
        read: async (position, length) =>
          (await file.read(position, length)).subarray(0, ++reads === 1 ? length : length - 1),
      };
    },
  };
  const { storage: watched, seen } = counted(storage);
  await expect(
    peekArchive({ storage: watched, path: "/file.zip", maxBytes: 1_000_000 }),
  ).rejects.toBeInstanceOf(UnreadableArchiveError);
  expect(seen.closed).toBe(1);
});

it("closes a tar once its entries are read, and when it is not one", async () => {
  const tarBytes = await buildTarBuffer([{ name: "a.txt", content: "alpha" }]);
  const { storage, seen } = counted(
    createMemoryStorage({ "/docs.tar": tarBytes, "/bad.tar": Buffer.from("not a tar") }),
  );
  const peek = (path: string) => peekArchive({ storage, path, maxBytes: DEFAULT_MAX_BYTES });
  expect((await peek("/docs.tar")).entries).toHaveLength(1);
  await expect(peek("/bad.tar")).rejects.toBeInstanceOf(UnreadableArchiveError);
  expect(seen).toMatchObject({ streamed: true, opened: 2, closed: 2 });
});
