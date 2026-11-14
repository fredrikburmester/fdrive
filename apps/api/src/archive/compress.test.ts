import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StorageError, type StorageProvider } from "@fdrive/core";
import { createLocalStorage } from "@fdrive/local";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as yauzl from "yauzl";
import { ZipFile } from "yazl";
import type { JobProgressPatch } from "../jobs/types.js";
import { compress, UnsupportedFormatError } from "./compress.js";
import { extractArchive } from "./extract.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createWriteStream: vi.fn(fs.createWriteStream) };
});

const FORMATS = ["zip", "tar.gz", "tar.zst"] as const;
const TAR_FORMATS = ["tar.gz", "tar.zst"] as const;

const tempPaths: string[] = [];

afterEach(async () => {
  vi.mocked(createWriteStream).mockClear();
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function tempDir(name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `fdrive-compress-test-${name}-`)));
  tempPaths.push(dir);
  return dir;
}

/** Local storage, which zips, over a fresh folder holding `files`. */
async function localStorage(
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<{ storage: StorageProvider; home: string }> {
  const home = await tempDir("home");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(home, path)), { recursive: true });
    await writeFile(join(home, path), content);
  }
  return { storage: createLocalStorage({ home }), home };
}

/** Storage holding `files` that can compress to `format`. */
async function storageFor(
  format: (typeof FORMATS)[number],
  files: Readonly<Record<string, string>>,
): Promise<StorageProvider> {
  return format === "zip" ? (await localStorage(files)).storage : createMemoryStorage(files);
}

function collectingReport(): {
  report: (patch: JobProgressPatch) => void;
  calls: JobProgressPatch[];
} {
  const calls: JobProgressPatch[] = [];
  return { report: (patch) => calls.push(patch), calls };
}

async function bytesOf(storage: StorageProvider, path: string): Promise<Buffer> {
  return Buffer.from(await new Response((await storage.download(path)).body).arrayBuffer());
}

async function zipEntries(
  bytes: Buffer,
): Promise<{ fileName: string; compressionMethod: number }[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("failed to open"));
        return;
      }
      const entries: { fileName: string; compressionMethod: number }[] = [];
      zipfile.on("entry", (entry: yauzl.Entry) => {
        entries.push({ fileName: entry.fileName, compressionMethod: entry.compressionMethod });
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

/** What extracting `archivePath` from `storage` into `/out` writes. */
async function extracted(storage: StorageProvider, archivePath: string) {
  const out = createMemoryStorage();
  await out.upload(archivePath, await bytesOf(storage, archivePath), { mkdirParents: true });
  await extractArchive({
    storage: out,
    archivePath,
    destination: "/out",
    tmpDir: await tempDir("extract"),
    signal: new AbortController().signal,
    report: () => {},
    maxBytes: 10 * 1024 * 1024,
  });
  const files = out.dump();
  delete files[archivePath];
  return files;
}

/** Downloads that stall after one chunk and record whether they were cancelled. */
function stallingDownloads(memory: StorageProvider): {
  storage: StorageProvider;
  delivered: () => boolean;
  cancelled: () => boolean;
} {
  let cancelled = false;
  let delivered = false;
  return {
    storage: {
      ...memory,
      download: async (...args) => ({
        ...(await memory.download(...args)),
        body: new ReadableStream<Uint8Array>({
          pull(stream) {
            if (!delivered) {
              delivered = true;
              stream.enqueue(new Uint8Array(4096));
            }
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    },
    delivered: () => delivered,
    cancelled: () => cancelled,
  };
}

describe("compress", () => {
  for (const format of FORMATS) {
    it(`streams a ${format} into a new file that round-trips through extractArchive`, async () => {
      const storage = await storageFor(format, {
        "/docs/a.txt": "alpha",
        "/docs/nested/b.txt": "bravo",
        "/docs/nested/c.txt": "charlie",
      });
      const { report, calls } = collectingReport();
      const target = `/docs.${format}`;

      await compress({
        storage,
        paths: ["/docs"],
        format,
        target,
        signal: new AbortController().signal,
        report,
      });

      // Straight into storage: no temporary archive is written anywhere.
      expect(createWriteStream).not.toHaveBeenCalled();
      expect(calls[0]).toEqual({ processed: 0, total: 3, bytes: 0 });
      expect(calls.at(-1)).toEqual({ processed: 3, total: 3, bytes: 17 });
      expect(await extracted(storage, target)).toEqual({
        "/out/docs/a.txt": "alpha",
        "/out/docs/nested/b.txt": "bravo",
        "/out/docs/nested/c.txt": "charlie",
      });
    });

    it(`refuses a taken ${format} target, keeps it and stops the archive`, async () => {
      const target = `/a.${format}`;
      const memory = createMemoryStorage({ "/a.txt": "x".repeat(65536), [target]: "kept" });
      const stalled = stallingDownloads(memory);
      const local = await localStorage({ "/a.txt": "a", [target]: "kept" });

      await expect(
        compress({
          storage: format === "zip" ? local.storage : stalled.storage,
          paths: ["/a.txt"],
          format,
          target,
          signal: new AbortController().signal,
          report: () => {},
        }),
      ).rejects.toMatchObject({ kind: "conflict" });

      if (format === "zip") {
        expect((await bytesOf(local.storage, target)).toString()).toBe("kept");
      } else {
        expect(memory.dump()[target]).toBe("kept");
        expect(stalled.cancelled()).toBe(true);
      }
    });
  }

  it("names zip entries as the storage's zip does: single files, folders, compression", async () => {
    const { storage } = await localStorage({
      "/report.txt": "just one file",
      "/mix/photo.jpg": "pretend-jpeg-bytes",
      "/mix/notes.txt": "some text notes some text notes some text notes",
    });
    const run = (paths: string[], target: string) =>
      compress({
        storage,
        paths,
        format: "zip",
        target,
        signal: new AbortController().signal,
        report: () => {},
      });

    await run(["/report.txt"], "/one.zip");
    const one = await zipEntries(await bytesOf(storage, "/one.zip"));
    expect(one.map((entry) => entry.fileName)).toEqual(["report.txt"]);
    await run(["/mix"], "/mix.zip");
    const mix = await zipEntries(await bytesOf(storage, "/mix.zip"));
    expect(mix.find((entry) => entry.fileName === "mix/photo.jpg")?.compressionMethod).toBe(0);
    expect(mix.find((entry) => entry.fileName === "mix/notes.txt")?.compressionMethod).toBe(8);
  });

  it("refuses a zip from storage that cannot build one", async () => {
    await expect(
      compress({
        storage: createMemoryStorage({ "/a.txt": "a" }),
        paths: ["/a.txt"],
        format: "zip",
        target: "/a.zip",
        signal: new AbortController().signal,
        report: () => {},
      }),
    ).rejects.toThrow(UnsupportedFormatError);
  });

  it("rejects tar.zst up front when unsupported", async () => {
    const storage = createMemoryStorage({ "/a.txt": "a" });
    await expect(
      compress({
        storage,
        paths: ["/a.txt"],
        format: "tar.zst",
        target: "/a.tar.zst",
        signal: new AbortController().signal,
        report: () => {},
        zstdSupported: false,
      }),
    ).rejects.toThrow(UnsupportedFormatError);
    expect(storage.dump()).toEqual({ "/a.txt": "a" });
  });

  it("rejects a job cancelled before it starts without writing anything", async () => {
    const storage = createMemoryStorage({ "/a.txt": "a" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      compress({
        storage,
        paths: ["/a.txt"],
        format: "tar.gz",
        target: "/a.tar.gz",
        signal: controller.signal,
        report: () => {},
      }),
    ).rejects.toThrow("cancelled");
    expect(storage.dump()).toEqual({ "/a.txt": "a" });
  });
});

describe("compress to tar", () => {
  it("never calls list on a top-level file selection", async () => {
    const storage = createMemoryStorage({ "/report.txt": "just one file" });
    const list = vi.fn(storage.list.bind(storage));

    await compress({
      storage: { ...storage, list },
      paths: ["/report.txt"],
      format: "tar.gz",
      target: "/report.tar.gz",
      signal: new AbortController().signal,
      report: () => {},
    });

    expect(list).not.toHaveBeenCalled();
    expect(await extracted(storage, "/report.tar.gz")).toEqual({
      "/out/report.txt": "just one file",
    });
  });

  it("archives the root itself without absolute entry names", async () => {
    const storage = createMemoryStorage({ "/a.txt": "alpha", "/sub/b.txt": "bravo" });

    await compress({
      storage,
      paths: ["/"],
      format: "tar.gz",
      target: "/sub/root.tar.gz",
      signal: new AbortController().signal,
      report: () => {},
    });

    expect(await extracted(storage, "/sub/root.tar.gz")).toEqual({
      "/out/a.txt": "alpha",
      "/out/sub/b.txt": "bravo",
    });
  });

  it("skips symlinks and other kinds, and dates a file without a time at the epoch", async () => {
    const storage = createMemoryStorage({ "/mix/a.txt": "a" });
    const withSymlink: StorageProvider = {
      ...storage,
      list: async (path: string) => [
        ...(await storage.list(path)),
        {
          name: "link",
          path: "/mix/link",
          kind: "symlink",
          size: 0,
          modifiedAt: new Date(0),
          ext: "",
        },
      ],
      stat: async (path) =>
        path === "/mix/a.txt"
          ? { kind: "file", size: 1, modifiedAt: null, contentType: null }
          : storage.stat(path),
    };

    await compress({
      storage: withSymlink,
      paths: ["/mix", "/mix/a.txt"],
      format: "tar.gz",
      target: "/mix.tar.gz",
      signal: new AbortController().signal,
      report: () => {},
    });

    expect(await extracted(storage, "/mix.tar.gz")).toEqual({
      "/out/mix/a.txt": "a",
      "/out/a.txt": "a",
    });
  });

  it("rethrows a listing's StorageError unchanged and writes nothing", async () => {
    const storage = createMemoryStorage();
    const failure = new StorageError("forbidden", "no access");
    const failing: StorageProvider = {
      ...storage,
      stat: async () => ({ kind: "dir", size: 0, modifiedAt: null, contentType: null }),
      list: async () => {
        throw failure;
      },
    };

    await expect(
      compress({
        storage: failing,
        paths: ["/mix"],
        format: "tar.gz",
        target: "/mix.tar.gz",
        signal: new AbortController().signal,
        report: () => {},
      }),
    ).rejects.toBe(failure);
    expect(storage.dump()).toEqual({});
  });

  for (const format of TAR_FORMATS) {
    it(`${format} cancels the file it was reading and writes nothing when the job is cancelled`, async () => {
      const controller = new AbortController();
      const stalled = stallingDownloads(createMemoryStorage({ "/large.txt": "x".repeat(65536) }));

      await expect(
        compress({
          storage: stalled.storage,
          paths: ["/large.txt"],
          format,
          target: `/large.${format}`,
          signal: controller.signal,
          report: (patch) => {
            if ((patch.bytes ?? 0) > 0) controller.abort();
          },
        }),
      ).rejects.toThrow();

      expect(stalled.cancelled()).toBe(true);
      await expect(stalled.storage.stat(`/large.${format}`)).rejects.toMatchObject({
        kind: "not_found",
      });
    });

    it(`${format} reports a failed download or body as itself and writes nothing`, async () => {
      for (const bodyError of [false, true]) {
        const memory = createMemoryStorage({ "/large.txt": "x".repeat(65536) });
        const failure = new StorageError("upstream_unavailable", "broken upstream");
        const storage: StorageProvider = {
          ...memory,
          download: async (...args) => {
            if (!bodyError) throw failure;
            return {
              ...(await memory.download(...args)),
              body: new ReadableStream<Uint8Array>({
                start(stream) {
                  stream.enqueue(new Uint8Array(4096));
                  stream.error(failure);
                },
              }),
            };
          },
        };

        await expect(
          compress({
            storage,
            paths: ["/large.txt"],
            format,
            target: `/large.${format}`,
            signal: new AbortController().signal,
            report: () => {},
          }),
        ).rejects.toBe(failure);
        expect(Object.keys(memory.dump())).toEqual(["/large.txt"]);
      }
    });

    it(`${format} stops reading files when the upload fails`, async () => {
      const failure = new StorageError("payload_too_large", "disk full");
      const stalled = stallingDownloads(createMemoryStorage({ "/large.txt": "x".repeat(65536) }));
      const storage: StorageProvider = {
        ...stalled.storage,
        // Fails once the archive is under way, as a full disk would.
        upload: async (_path, body) => {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          void reader.read().catch(() => undefined);
          await vi.waitFor(() => expect(stalled.delivered()).toBe(true));
          await reader.cancel(failure);
          throw failure;
        },
      };

      await expect(
        compress({
          storage,
          paths: ["/large.txt"],
          format,
          target: `/large.${format}`,
          signal: new AbortController().signal,
          report: () => {},
        }),
      ).rejects.toBe(failure);
      expect(stalled.cancelled()).toBe(true);
    });
  }
});

describe("compress to zip on the files folder", () => {
  it("leaves nothing at the target or beside it when the job is cancelled", async () => {
    // Stored, not deflated, so the archive is still being read when cancelled.
    const { storage, home } = await localStorage({ "/big.jpg": new Uint8Array(4 * 1024 * 1024) });
    const controller = new AbortController();

    await expect(
      compress({
        storage,
        paths: ["/big.jpg"],
        format: "zip",
        target: "/big.zip",
        signal: controller.signal,
        report: (patch) => {
          if ((patch.bytes ?? 0) > 0) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(await readdir(home)).toEqual(["big.jpg"]);
  });

  it("reports the zip writer's own failure and leaves nothing behind", async () => {
    const failure = new Error("zip writer failure");
    const add = vi.spyOn(ZipFile.prototype, "addReadStreamLazy").mockImplementationOnce(function (
      this: ZipFile,
    ) {
      this.emit("error", failure);
    });
    try {
      const { storage, home } = await localStorage({ "/a.txt": "data" });
      await expect(
        compress({
          storage,
          paths: ["/a.txt"],
          format: "zip",
          target: "/a.zip",
          signal: new AbortController().signal,
          report: () => {},
        }),
      ).rejects.toBe(failure);
      expect(await readdir(home)).toEqual(["a.txt"]);
    } finally {
      add.mockRestore();
    }
  });
});
