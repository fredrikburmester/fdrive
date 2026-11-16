import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync, zstdCompressSync } from "node:zlib";
import type { OpenFile, StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import * as tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { buildRawZip } from "../../test/fixtures/build-zip.js";
import type { JobProgressPatch } from "../jobs/types.js";
import { ArchiveEntryCapExceededError, extractArchive } from "./extract.js";
import { ByteCapExceededError, JobAbortedError } from "./stream-utils.js";

/** What extracting once copied a zip into before reading it. */
const isSpool = (name: string) => name.startsWith("fdrive-extract-") && name.endsWith(".zip");

/** Follows what `storage.open` hands out: how it is read, and whether it is closed. */
function watchOpens(storage: StorageProvider) {
  const seen = { streamed: false, bytesRead: 0, closed: false };
  const open = storage.open.bind(storage);
  vi.spyOn(storage, "open").mockImplementation(async (path) => {
    const file = await open(path);
    return {
      ...file,
      stream: (start, end) => {
        seen.streamed = true;
        return file.stream(start, end);
      },
      read: async (position, length) => {
        const bytes = await file.read(position, length);
        seen.bytesRead += bytes.length;
        return bytes;
      },
      close: async () => {
        seen.closed = true;
        await file.close();
      },
    };
  });
  return seen;
}

/** An open archive whose bytes are `body`, for a stand-in storage. */
function openBody(size: number, body: ReadableStream<Uint8Array>): OpenFile {
  return {
    size,
    modifiedAt: new Date(0),
    stream: () => body,
    read: async () => new Uint8Array(),
    close: async () => {},
  };
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

interface TarEntrySpec {
  readonly name: string;
  readonly content?: string;
  readonly type?: "file" | "symlink" | "directory";
  readonly linkname?: string;
}

function buildTar(entries: readonly TarEntrySpec[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);

    for (const entry of entries) {
      if (entry.type === "symlink") {
        pack
          .entry({ name: entry.name, type: "symlink", linkname: entry.linkname ?? "target" })
          .end();
        continue;
      }
      if (entry.type === "directory") {
        pack.entry({ name: entry.name, type: "directory" }).end();
        continue;
      }
      const content = entry.content ?? "";
      pack.entry({ name: entry.name, size: Buffer.byteLength(content) }, content);
    }
    pack.finalize();
  });
}

function buildCompressedZip(
  entries: readonly { name: string; content: Buffer }[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zipfile = new ZipFile();
    const chunks: Buffer[] = [];
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zipfile.outputStream.on("error", reject);
    for (const entry of entries) {
      zipfile.addBuffer(entry.content, entry.name);
    }
    zipfile.end();
  });
}

function collectingReport(): {
  report: (patch: JobProgressPatch) => void;
  calls: JobProgressPatch[];
} {
  const calls: JobProgressPatch[] = [];
  return { report: (patch) => calls.push(patch), calls };
}

describe("extractArchive: zip", () => {
  it("extracts every file entry and creates parent folders implicitly", async () => {
    const zipBytes = buildRawZip([
      { name: "a.txt", content: Buffer.from("alpha") },
      { name: "nested/b.txt", content: Buffer.from("bravo") },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/docs.zip", zipBytes);
    const { report, calls } = collectingReport();

    const result = await extractArchive({
      storage,
      archivePath: "/docs.zip",
      destination: "/out",
      signal: new AbortController().signal,
      report,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result).toEqual({ path: "/out" });
    expect(storage.dump()).toMatchObject({
      "/out/a.txt": "alpha",
      "/out/nested/b.txt": "bravo",
    });
    expect(calls.some((c) => c.processed === 2)).toBe(true);
  });

  it("skips a directory entry without erroring", async () => {
    const zipBytes = buildRawZip([
      { name: "sub/", content: new Uint8Array() },
      { name: "sub/file.txt", content: Buffer.from("hello") },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/a.zip", zipBytes);

    const result = await extractArchive({
      storage,
      archivePath: "/a.zip",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result.path).toBe("/out");
    expect(storage.dump()).toMatchObject({ "/out/sub/file.txt": "hello" });
  });

  it("skips zip-slip entries (.. escape and absolute path), writes the rest, and reports them", async () => {
    const zipBytes = buildRawZip([
      { name: "good.txt", content: Buffer.from("good") },
      { name: "../../evil.txt", content: Buffer.from("evil") },
      { name: "/etc/passwd", content: Buffer.from("root") },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/evil.zip", zipBytes);

    const result = await extractArchive({
      storage,
      archivePath: "/evil.zip",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result.path).toBe("/out");
    expect(result.warning).toContain("2");
    expect(result.warning).toContain("../../evil.txt");
    expect(result.warning).toContain("/etc/passwd");
    const written = storage.dump();
    expect(written["/out/good.txt"]).toBe("good");
    expect(
      Object.keys(written).some((path) => path.startsWith("/out/") && path !== "/out/good.txt"),
    ).toBe(false);
  });

  it("fails the job when every entry is unsafe (nothing extracted)", async () => {
    const zipBytes = buildRawZip([{ name: "/etc/passwd", content: Buffer.from("root") }]);
    const storage = createMemoryStorage();
    await storage.upload("/all-evil.zip", zipBytes);

    await expect(
      extractArchive({
        storage,
        archivePath: "/all-evil.zip",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow(/no entries were extracted/);
  });

  it("fails with a plain message for a genuinely empty archive (no entries at all)", async () => {
    const zipBytes = buildRawZip([]);
    const storage = createMemoryStorage();
    await storage.upload("/empty.zip", zipBytes);

    await expect(
      extractArchive({
        storage,
        archivePath: "/empty.zip",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow("no entries were extracted");
  });

  it("rejects a corrupt zip file that yauzl cannot open", async () => {
    const storage = createMemoryStorage();
    await storage.upload("/corrupt.zip", Buffer.from("not a zip file at all"));

    await expect(
      extractArchive({
        storage,
        archivePath: "/corrupt.zip",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow();
  });

  it("reads a zip where it lies, by position, and never writes it to temp", async () => {
    const large = "a".repeat(1024 * 1024);
    const zipBytes = buildRawZip([
      { name: "a.txt", content: Buffer.from(large) },
      { name: "b.txt", content: Buffer.from("b") },
    ]);
    const storage = createMemoryStorage({ "/a.zip": zipBytes });
    const opened = watchOpens(storage);
    const spooled = () => readdir(tmpdir()).then((names) => names.filter(isSpool));
    const before = await spooled();
    const { report, calls } = collectingReport();

    await extractArchive({
      storage,
      archivePath: "/a.zip",
      destination: "/out",
      signal: new AbortController().signal,
      report,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(storage.dump()).toMatchObject({ "/out/a.txt": large, "/out/b.txt": "b" });
    expect(opened.streamed).toBe(false);
    // Its end, where yauzl looks for the central directory, and then each entry once.
    expect(opened.bytesRead).toBeLessThan(zipBytes.length + 70 * 1024);
    expect(calls.at(-1)).toMatchObject({ processed: 2 });
    expect(calls.some((patch) => (patch.bytes ?? 0) > 0)).toBe(true);
    expect(opened.closed).toBe(true);
    expect(await spooled()).toEqual(before);
  });

  it("refuses a zip larger than the byte cap before reading it", async () => {
    const zipBytes = buildRawZip([{ name: "a.txt", content: Buffer.from("a".repeat(1000)) }]);
    const storage = createMemoryStorage({ "/big.zip": zipBytes });
    const opened = watchOpens(storage);

    await expect(
      extractArchive({
        storage,
        archivePath: "/big.zip",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: 10,
      }),
    ).rejects.toThrow(ByteCapExceededError);

    expect(opened.bytesRead).toBe(0);
    expect(opened.closed).toBe(true);
  });

  it("rejects a compressed zip whose cumulative expanded bytes exceed the cap", async () => {
    const zipBytes = await buildCompressedZip([
      { name: "one.txt", content: Buffer.from("x".repeat(600)) },
      { name: "two.txt", content: Buffer.from("y".repeat(600)) },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/bomb.zip", zipBytes);
    expect(zipBytes.length).toBeLessThan(1000);

    await expect(
      extractArchive({
        storage,
        archivePath: "/bomb.zip",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: 1000,
      }),
    ).rejects.toThrow(ByteCapExceededError);

    expect(storage.dump()["/out/one.txt"]).toBe("x".repeat(600));
    expect(storage.dump()["/out/two.txt"]).toBeUndefined();
  });

  it("caps the number of entries inspected", async () => {
    const zipBytes = buildRawZip([
      { name: "one.txt", content: new Uint8Array() },
      { name: "two.txt", content: new Uint8Array() },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/many.zip", zipBytes);

    await expect(
      extractArchive({
        storage,
        archivePath: "/many.zip",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
        maxEntries: 1,
      }),
    ).rejects.toThrow(ArchiveEntryCapExceededError);
  });
});

describe("extractArchive: tar", () => {
  it("extracts a plain .tar archive", async () => {
    const tarBuffer = await buildTar([{ name: "a.txt", content: "alpha" }]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar", tarBuffer);

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result).toEqual({ path: "/out" });
    expect(storage.dump()).toMatchObject({ "/out/a.txt": "alpha" });
  });

  it("skips symlink entries and extracts the rest", async () => {
    const tarBuffer = await buildTar([
      { name: "link", type: "symlink", linkname: "somewhere" },
      { name: "file.txt", content: "hello" },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar", tarBuffer);

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result).toEqual({ path: "/out" });
    expect(storage.dump()).toMatchObject({ "/out/file.txt": "hello" });
    expect(storage.dump()["/out/link"]).toBeUndefined();
  });

  it("skips zip-slip entries in a tar and reports them", async () => {
    const tarBuffer = await buildTar([
      { name: "good.txt", content: "good" },
      { name: "../evil.txt", content: "evil" },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar", tarBuffer);

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result.warning).toContain("../evil.txt");
    expect(storage.dump()).toMatchObject({ "/out/good.txt": "good" });
    expect(storage.dump()["/evil.txt"]).toBeUndefined();
  });

  it("extracts a .tar.gz archive", async () => {
    const tarBuffer = await buildTar([{ name: "a.txt", content: "alpha" }]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar.gz", gzipSync(tarBuffer));

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar.gz",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result).toEqual({ path: "/out" });
    expect(storage.dump()).toMatchObject({ "/out/a.txt": "alpha" });
  });

  it("rejects a tar.gz whose expanded entries exceed the cap", async () => {
    const tarBuffer = await buildTar([{ name: "large.txt", content: "x".repeat(20_000) }]);
    const archive = gzipSync(tarBuffer);
    const storage = createMemoryStorage();
    await storage.upload("/bomb.tar.gz", archive);
    expect(archive.length).toBeLessThan(1000);

    await expect(
      extractArchive({
        storage,
        archivePath: "/bomb.tar.gz",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: 1000,
      }),
    ).rejects.toThrow(ByteCapExceededError);

    expect(storage.dump()["/out/large.txt"]).toBeUndefined();
  });

  it("caps decompressed tar bytes consumed internally as PAX metadata", async () => {
    const longName = `${"nested/".repeat(180)}file.txt`;
    const tarBuffer = await buildTar([{ name: longName, content: "x" }]);
    const archive = gzipSync(tarBuffer);
    const memory = createMemoryStorage();
    const cancel = vi.fn();
    let sent = false;
    const holdOpen = new Promise<void>(() => {});
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          return holdOpen;
        }
        sent = true;
        controller.enqueue(archive);
      },
      cancel,
    });
    const storage: StorageProvider = {
      ...memory,
      open: async () => openBody(archive.length, body),
    };
    expect(archive.length).toBeLessThan(1000);
    expect(tarBuffer.length).toBeGreaterThan(1000);

    await expect(
      extractArchive({
        storage,
        archivePath: "/pax-bomb.tar.gz",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: 1000,
      }),
    ).rejects.toThrow(ByteCapExceededError);

    expect(cancel).toHaveBeenCalledOnce();
    expect(Object.keys(memory.dump()).some((path) => path.startsWith("/out/"))).toBe(false);
  });

  it("extracts a .tar.zst archive (Node 22.15+)", async () => {
    const tarBuffer = await buildTar([{ name: "a.txt", content: "alpha" }]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar.zst", zstdCompressSync(tarBuffer));

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar.zst",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result).toEqual({ path: "/out" });
    expect(storage.dump()).toMatchObject({ "/out/a.txt": "alpha" });
  });

  it("rejects tar.zst up front when unsupported", async () => {
    const tarBuffer = await buildTar([{ name: "a.txt", content: "alpha" }]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar.zst", zstdCompressSync(tarBuffer));

    await expect(
      extractArchive({
        storage,
        archivePath: "/a.tar.zst",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
        zstdSupported: false,
      }),
    ).rejects.toThrow(/unsupported/);
  });

  it("enforces the byte cap while streaming and aborts the read", async () => {
    const tarBuffer = await buildTar([{ name: "a.txt", content: "a".repeat(5000) }]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar.gz", gzipSync(tarBuffer));

    await expect(
      extractArchive({
        storage,
        archivePath: "/a.tar.gz",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: 10,
      }),
    ).rejects.toThrow();
  });

  it("stops extracting once the signal is aborted", async () => {
    const tarBuffer = await buildTar([
      { name: "a.txt", content: "alpha" },
      { name: "b.txt", content: "bravo" },
    ]);
    const storage = createMemoryStorage();
    await storage.upload("/two.tar", tarBuffer);
    const controller = new AbortController();

    await expect(
      extractArchive({
        storage,
        archivePath: "/two.tar",
        destination: "/out",
        signal: controller.signal,
        report: (patch) => {
          if (patch.processed === 1) {
            controller.abort();
          }
        },
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow(JobAbortedError);
  });
});

describe("extractArchive: bare .gz", () => {
  it("decompresses into a single file named after the archive without .gz", async () => {
    const storage = createMemoryStorage();
    await storage.upload("/notes.txt.gz", gzipSync(Buffer.from("hello world")));

    const result = await extractArchive({
      storage,
      archivePath: "/notes.txt.gz",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result).toEqual({ path: "/out" });
    expect(storage.dump()).toMatchObject({ "/out/notes.txt": "hello world" });
  });

  it("enforces the byte cap on expanded content", async () => {
    const storage = createMemoryStorage();
    const archive = gzipSync(Buffer.from("x".repeat(5000)));
    await storage.upload("/big.txt.gz", archive);
    expect(archive.length).toBeLessThan(100);

    await expect(
      extractArchive({
        storage,
        archivePath: "/big.txt.gz",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: 100,
      }),
    ).rejects.toThrow(ByteCapExceededError);
    expect(storage.dump()["/out/big.txt"]).toBeUndefined();
  });
});

describe("extractArchive: format detection", () => {
  it("rejects an archive path with no recognized extension", async () => {
    const storage = createMemoryStorage();
    await storage.upload("/mystery.xyz", Buffer.from("data"));

    await expect(
      extractArchive({
        storage,
        archivePath: "/mystery.xyz",
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow(/unsupported/);
  });
});

it("preserves an existing destination instead of silently overwriting edited content", async () => {
  const bytes = buildRawZip([{ name: "kept.txt", content: Buffer.from("archive") }]);
  const storage = createMemoryStorage({ "/a.zip": bytes, "/out/kept.txt": "edited" });
  await expect(
    extractArchive({
      storage,
      archivePath: "/a.zip",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    }),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(storage.dump()["/out/kept.txt"]).toBe("edited");
});

it("decodes legacy ZIP names without colliding on replacement characters", async () => {
  const bytes = buildRawZip([
    {
      name: "ignored",
      nameBytes: Uint8Array.from([99, 97, 102, 130, 46, 116, 120, 116]),
      content: Buffer.from("café"),
    },
    {
      name: "ignored",
      nameBytes: Uint8Array.from([99, 97, 102, 138, 46, 116, 120, 116]),
      content: Buffer.from("cafè"),
    },
  ]);
  const storage = createMemoryStorage({ "/a.zip": bytes });
  await extractArchive({
    storage,
    archivePath: "/a.zip",
    destination: "/out",
    signal: new AbortController().signal,
    report: () => {},
    maxBytes: DEFAULT_MAX_BYTES,
  });
  expect(storage.dump()["/out/café.txt"]).toBe("café");
  expect(storage.dump()["/out/cafè.txt"]).toBe("cafè");
});

it.each(["..gz", "...gz"])(
  "refuses unsafe stripped gzip name %s without reading it",
  async (name) => {
    const storage = createMemoryStorage({ [`/${name}`]: gzipSync("bad") });
    const opened = watchOpens(storage);
    await expect(
      extractArchive({
        storage,
        archivePath: `/${name}`,
        destination: "/out",
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow("no entries were extracted");
    expect(opened).toEqual({ streamed: false, bytesRead: 0, closed: true });
  },
);

it("stops reading a zip once aborted between entries, and closes it", async () => {
  const storage = createMemoryStorage({
    "/a.zip": buildRawZip([
      { name: "a.txt", content: Buffer.from("a") },
      { name: "b.txt", content: Buffer.from("b") },
    ]),
  });
  const opened = watchOpens(storage);
  const controller = new AbortController();
  const result = extractArchive({
    storage,
    archivePath: "/a.zip",
    destination: "/out",
    signal: controller.signal,
    report: (progress) => {
      if (progress.processed === 1) controller.abort();
    },
    maxBytes: DEFAULT_MAX_BYTES,
  });
  await expect(result).rejects.toThrow(JobAbortedError);
  expect(storage.dump()["/out/b.txt"]).toBeUndefined();
  expect(opened.closed).toBe(true);
});

it("fails a zip that reads short of what its directory declares, and closes it", async () => {
  const memory = createMemoryStorage({
    "/a.zip": buildRawZip([{ name: "a.txt", content: Buffer.from("alpha") }]),
  });
  const opened = watchOpens(memory);
  const storage: StorageProvider = {
    ...memory,
    open: async (path) => {
      const file = await memory.open(path);
      return {
        ...file,
        read: async (position, length) => (await file.read(position, length)).subarray(1),
      };
    },
  };
  await expect(
    extractArchive({
      storage,
      archivePath: "/a.zip",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    }),
  ).rejects.toThrow("the archive ended early");
  expect(opened.closed).toBe(true);
});

it("refuses existing tar outputs and closes the failed extraction", async () => {
  const storage = createMemoryStorage({ "/out/a.txt": "user edit" });
  await storage.upload(
    "/docs.tar",
    await buildTar([{ name: "a.txt", content: "archive version" }]),
  );
  await expect(
    extractArchive({
      storage,
      archivePath: "/docs.tar",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    }),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(storage.dump()["/out/a.txt"]).toBe("user edit");
});

it("propagates a gzip read failure and cancels decompression", async () => {
  const storage = createMemoryStorage();
  await storage.upload("/file.gz", new Uint8Array());
  storage.open = async () =>
    openBody(
      0,
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("upstream disconnected"));
        },
      }),
    );
  await expect(
    extractArchive({
      storage,
      archivePath: "/file.gz",
      destination: "/out",
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    }),
  ).rejects.toThrow("upstream disconnected");
});
