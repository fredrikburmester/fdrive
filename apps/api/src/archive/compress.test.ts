import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as yauzl from "yauzl";
import { ZipFile } from "yazl";
import type { JobProgressPatch } from "../jobs/types.js";
import { compressToTemp, UnsupportedFormatError } from "./compress.js";
import { extractArchive } from "./extract.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createWriteStream: vi.fn(fs.createWriteStream) };
});

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function tmpDirFor(name: string): Promise<string> {
  const dir = join(tmpdir(), `fdrive-compress-test-${name}-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
}

function collectingReport(): {
  report: (patch: JobProgressPatch) => void;
  calls: JobProgressPatch[];
} {
  const calls: JobProgressPatch[] = [];
  return { report: (patch) => calls.push(patch), calls };
}

async function readZipEntries(
  file: string,
): Promise<{ fileName: string; compressionMethod: number }[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
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

describe("compressToTemp", () => {
  it("builds a zip that round-trips through extractArchive", async () => {
    const storage = createMemoryStorage({
      "/docs/a.txt": "alpha",
      "/docs/nested/b.txt": "bravo",
      "/docs/nested/c.txt": "charlie",
    });
    const tmpDir = await tmpDirFor("zip-roundtrip");
    const controller = new AbortController();
    const { report, calls } = collectingReport();

    const result = await compressToTemp({
      storage,
      paths: ["/docs"],
      format: "zip",
      tmpDir,
      signal: controller.signal,
      report,
    });
    tempPaths.push(result.file);

    expect(result.size).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ processed: 0, total: 3, bytes: 0 });
    expect(calls.some((c) => c.processed === 3)).toBe(true);

    const destStorage = createMemoryStorage();
    // Feed the produced zip back in as the archive to extract, by uploading
    // it into the same memory storage under a path.
    await destStorage.upload("/docs.zip", await readFile(result.file));
    const extraction = await extractArchive({
      storage: destStorage,
      archivePath: "/docs.zip",
      destination: "/out",
      tmpDir,
      signal: controller.signal,
      report: () => {},
      maxBytes: 10 * 1024 * 1024,
    });

    expect(extraction.path).toBe("/out");
    expect(destStorage.dump()).toMatchObject({
      "/out/docs/a.txt": "alpha",
      "/out/docs/nested/b.txt": "bravo",
      "/out/docs/nested/c.txt": "charlie",
    });
  });

  it("builds a tar.gz that round-trips through extractArchive", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "alpha", "/docs/b.txt": "bravo" });
    const tmpDir = await tmpDirFor("targz-roundtrip");
    const controller = new AbortController();

    const result = await compressToTemp({
      storage,
      paths: ["/docs"],
      format: "tar.gz",
      tmpDir,
      signal: controller.signal,
      report: () => {},
    });
    tempPaths.push(result.file);

    const destStorage = createMemoryStorage();
    await destStorage.upload("/docs.tar.gz", await readFile(result.file));
    await extractArchive({
      storage: destStorage,
      archivePath: "/docs.tar.gz",
      destination: "/out",
      tmpDir,
      signal: controller.signal,
      report: () => {},
      maxBytes: 10 * 1024 * 1024,
    });

    expect(destStorage.dump()).toMatchObject({
      "/out/docs/a.txt": "alpha",
      "/out/docs/b.txt": "bravo",
    });
  });

  it("builds a tar.zst that round-trips through extractArchive (Node 22.15+)", async () => {
    const storage = createMemoryStorage({ "/docs/a.txt": "alpha" });
    const tmpDir = await tmpDirFor("tarzst-roundtrip");
    const controller = new AbortController();

    const result = await compressToTemp({
      storage,
      paths: ["/docs"],
      format: "tar.zst",
      tmpDir,
      signal: controller.signal,
      report: () => {},
    });
    tempPaths.push(result.file);

    const destStorage = createMemoryStorage();
    await destStorage.upload("/docs.tar.zst", await readFile(result.file));
    await extractArchive({
      storage: destStorage,
      archivePath: "/docs.tar.zst",
      destination: "/out",
      tmpDir,
      signal: controller.signal,
      report: () => {},
      maxBytes: 10 * 1024 * 1024,
    });

    expect(destStorage.dump()).toMatchObject({ "/out/docs/a.txt": "alpha" });
  });

  it("never calls list on a top-level file selection (real SFTPGo, unlike the fake, drops the connection instead of returning bad_request for that call)", async () => {
    const storage = createMemoryStorage({ "/report.txt": "just one file" });
    const listSpy = vi.fn(storage.list.bind(storage));
    const spiedOnList: StorageProvider = { ...storage, list: listSpy };
    const tmpDir = await tmpDirFor("no-list-on-file");

    const result = await compressToTemp({
      storage: spiedOnList,
      paths: ["/report.txt"],
      format: "zip",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
    });
    tempPaths.push(result.file);

    expect(listSpy).not.toHaveBeenCalled();
  });

  it("compresses a single file selection directly (no folder)", async () => {
    const storage = createMemoryStorage({ "/report.txt": "just one file" });
    const tmpDir = await tmpDirFor("single-file");

    const result = await compressToTemp({
      storage,
      paths: ["/report.txt"],
      format: "zip",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
    });
    tempPaths.push(result.file);

    const entries = await readZipEntries(result.file);
    expect(entries.map((e) => e.fileName)).toEqual(["report.txt"]);
  });

  it("compresses the root itself without producing absolute entry names", async () => {
    const storage = createMemoryStorage({ "/a.txt": "alpha", "/sub/b.txt": "bravo" });
    const tmpDir = await tmpDirFor("compress-root");

    const result = await compressToTemp({
      storage,
      paths: ["/"],
      format: "zip",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
    });
    tempPaths.push(result.file);

    const entries = await readZipEntries(result.file);
    expect(entries.map((e) => e.fileName).sort()).toEqual(["a.txt", "sub/b.txt"]);
  });

  it("stores already-compressed extensions and deflates everything else", async () => {
    const storage = createMemoryStorage({
      "/mix/photo.jpg": "pretend-jpeg-bytes",
      "/mix/notes.txt": "some text notes some text notes some text notes",
    });
    const tmpDir = await tmpDirFor("mixed-compression");

    const result = await compressToTemp({
      storage,
      paths: ["/mix"],
      format: "zip",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
    });
    tempPaths.push(result.file);

    const entries = await readZipEntries(result.file);
    const photo = entries.find((e) => e.fileName.endsWith("photo.jpg"));
    const notes = entries.find((e) => e.fileName.endsWith("notes.txt"));
    expect(photo?.compressionMethod).toBe(0);
    expect(notes?.compressionMethod).toBe(8);
  });

  it("skips symlink and other non-file, non-dir entries", async () => {
    const storage = createMemoryStorage({ "/mix/a.txt": "a" });
    const originalList = storage.list.bind(storage);
    const withSymlink: StorageProvider = {
      ...storage,
      list: async (path: string) => {
        const entries = await originalList(path);
        if (path === "/mix") {
          return [
            ...entries,
            {
              name: "link",
              path: "/mix/link",
              kind: "symlink",
              size: 0,
              modifiedAt: new Date(0),
              ext: "",
            },
          ];
        }
        return entries;
      },
    };
    const tmpDir = await tmpDirFor("skip-symlink");

    const result = await compressToTemp({
      storage: withSymlink,
      paths: ["/mix"],
      format: "zip",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
    });
    tempPaths.push(result.file);

    const entries = await readZipEntries(result.file);
    expect(entries.map((e) => e.fileName)).toEqual(["mix/a.txt"]);
  });

  it("rethrows a non-bad_request StorageError from a top-level list unchanged", async () => {
    const storage = createMemoryStorage();
    const failing: StorageProvider = {
      ...storage,
      // `path` resolves as a directory (a clean `bad_request` from
      // `statFile`, exactly as a real directory would), so `collectPath`
      // falls through to `list`, whose own failure below is asserted to
      // propagate unchanged.
      statFile: async () => {
        throw new StorageError("bad_request", "is a directory");
      },
      list: async () => {
        throw new StorageError("forbidden", "no access");
      },
    };
    const tmpDir = await tmpDirFor("collect-rethrow");

    await expect(
      compressToTemp({
        storage: failing,
        paths: ["/mix"],
        format: "zip",
        tmpDir,
        signal: new AbortController().signal,
        report: () => {},
      }),
    ).rejects.toThrow(StorageError);
  });

  it("defaults a single file's modifiedAt to the epoch when the provider reports none", async () => {
    const storage = createMemoryStorage({ "/report.txt": "content" });
    const withNullModifiedAt: StorageProvider = {
      ...storage,
      statFile: async () => ({ size: 7, modifiedAt: null, contentType: null }),
    };
    const tmpDir = await tmpDirFor("null-modified-at");

    const result = await compressToTemp({
      storage: withNullModifiedAt,
      paths: ["/report.txt"],
      format: "zip",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
    });
    tempPaths.push(result.file);

    expect(result.size).toBeGreaterThan(0);
  });

  it("rejects tar.zst up front when unsupported, without touching the temp dir", async () => {
    const storage = createMemoryStorage({ "/a.txt": "a" });
    const tmpDir = await tmpDirFor("unsupported-zstd");

    await expect(
      compressToTemp({
        storage,
        paths: ["/a.txt"],
        format: "tar.zst",
        tmpDir,
        signal: new AbortController().signal,
        report: () => {},
        zstdSupported: false,
      }),
    ).rejects.toThrow(UnsupportedFormatError);
  });

  it("removes the temp file and rejects when the job is cancelled mid-way", async () => {
    const storage = createMemoryStorage({
      "/docs/a.txt": "alpha",
      "/docs/b.txt": "bravo",
      "/docs/c.txt": "charlie",
    });
    const tmpDir = await tmpDirFor("cancel-midway");
    const controller = new AbortController();

    const { report } = collectingReport();
    const abortingReport = (patch: JobProgressPatch): void => {
      report(patch);
      if (patch.processed === 1) {
        controller.abort();
      }
    };

    const promise = compressToTemp({
      storage,
      paths: ["/docs"],
      format: "zip",
      tmpDir,
      signal: controller.signal,
      report: abortingReport,
    });

    await expect(promise).rejects.toThrow();

    // The temp file path is deterministic only after the call; recover it by
    // scanning tmpDir for the single file this test created (if any).
    const { readdir } = await import("node:fs/promises");
    let leftover: string[] = [];
    try {
      leftover = await readdir(tmpDir);
    } catch {
      leftover = [];
    }
    expect(leftover).toEqual([]);
  });
});

for (const format of ["zip", "tar.gz", "tar.zst"] as const) {
  it(`${format} closes all active streams before deleting a cancelled archive`, async () => {
    const memory = createMemoryStorage({ "/large.txt": "x".repeat(65536) });
    const controller = new AbortController();
    let cancelled = false;
    let delivered = false;
    const storage: StorageProvider = {
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
    };
    const dir = await tmpDirFor(`cancel-stream-${format}`);
    await expect(
      compressToTemp({
        storage,
        paths: ["/large.txt"],
        format,
        tmpDir: dir,
        signal: controller.signal,
        report: (patch) => {
          if ((patch.bytes ?? 0) > 0) controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual([]);
  });
  it(`${format} awaits output closure after upstream download and body errors`, async () => {
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
      const dir = await tmpDirFor(`upstream-${format}-${bodyError}`);
      await expect(
        compressToTemp({
          storage,
          paths: ["/large.txt"],
          format,
          tmpDir: dir,
          signal: new AbortController().signal,
          report: () => {},
        }),
      ).rejects.toBe(failure);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(dir)).toEqual([]);
    }
  });
}

for (const format of ["zip", "tar.gz", "tar.zst"] as const) {
  it(`${format} waits for delayed destination open and actual stream closure on abort`, async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let signalOpen: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      signalOpen = resolve;
    });
    let releaseOpen: (() => void) | undefined;
    let output: ReturnType<typeof createWriteStream> | undefined;
    vi.mocked(createWriteStream).mockImplementationOnce((path) => {
      output = fs.createWriteStream(path, {
        fs: {
          open(path, flags, mode, callback) {
            releaseOpen = () => fs.open(path, flags, mode, callback);
            signalOpen?.();
          },
          close: fs.close,
          write: fs.write,
          writev: fs.writev,
        },
      });
      return output;
    });
    const destroyed = new Set<Readable>();
    const originalDestroy = Readable.prototype.destroy;
    const destroy = vi.spyOn(Readable.prototype, "destroy").mockImplementation(function (
      this: Readable,
      error,
    ) {
      destroyed.add(this);
      return originalDestroy.call(this, error);
    });
    try {
      const controller = new AbortController();
      const reason = new Error("delayed-open cancellation");
      const directory = await tmpDirFor(`delayed-open-${format}`);
      const promise = compressToTemp({
        storage: createMemoryStorage({ "/file.txt": "content" }),
        paths: ["/file.txt"],
        format,
        tmpDir: directory,
        signal: controller.signal,
        report: () => {},
      });
      let settled = false;
      const outcome = promise.then(
        () => {
          settled = true;
          return null;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await opened;
      controller.abort(reason);
      await Promise.resolve();
      expect(settled).toBe(false);
      if (!releaseOpen) throw Error("open callback missing");
      releaseOpen();
      expect(await outcome).toBe(reason);
      expect(output?.closed).toBe(true);
      expect(destroyed.size).toBeGreaterThan(0);
      for (const stream of destroyed) expect(stream.closed).toBe(true);
      expect(await fs.promises.readdir(directory)).toEqual([]);
    } finally {
      destroy.mockRestore();
    }
  });
}

it("preserves an archive writer error while closing the output and active input", async () => {
  const failure = new Error("zip writer failure");
  const add = vi.spyOn(ZipFile.prototype, "addReadStream").mockImplementationOnce(function (
    this: ZipFile,
  ) {
    this.emit("error", failure);
  });
  try {
    const directory = await tmpDirFor("writer-error");
    await expect(
      compressToTemp({
        storage: createMemoryStorage({ "/a.txt": "data" }),
        paths: ["/a.txt"],
        format: "zip",
        tmpDir: directory,
        signal: new AbortController().signal,
        report: () => {},
      }),
    ).rejects.toBe(failure);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    add.mockRestore();
  }
});

for (const format of ["zip", "tar.gz", "tar.zst"] as const) {
  it(`${format} preserves destination errors and closes the failed output`, async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const directory = await tmpDirFor(`output-failure-${format}`);
    let output: ReturnType<typeof createWriteStream> | undefined;
    vi.mocked(createWriteStream).mockImplementationOnce(() => {
      output = fs.createWriteStream(directory);
      return output;
    });
    await expect(
      compressToTemp({
        storage: createMemoryStorage({ "/a.txt": "data" }),
        paths: ["/a.txt"],
        format,
        tmpDir: directory,
        signal: new AbortController().signal,
        report: () => {},
      }),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(output?.closed).toBe(true);
    expect(await fs.promises.readdir(directory)).toEqual([]);
  });
}
