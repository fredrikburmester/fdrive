import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildRawZip } from "../../test/fixtures/build-zip.js";
import { createMemoryStorage } from "../../test/fixtures/memory-storage.js";
import type { JobProgressPatch } from "../jobs/types.js";
import { extractArchive } from "./extract.js";
import { ByteCapExceededError, JobAbortedError } from "./stream-utils.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function tmpDirFor(name: string): Promise<string> {
  const dir = join(tmpdir(), `fdrive-extract-test-${name}-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  tempPaths.push(dir);
  return dir;
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
    const tmpDir = await tmpDirFor("zip-basic");
    const { report, calls } = collectingReport();

    const result = await extractArchive({
      storage,
      archivePath: "/docs.zip",
      destination: "/out",
      tmpDir,
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
    const tmpDir = await tmpDirFor("zip-dir-entry");

    const result = await extractArchive({
      storage,
      archivePath: "/a.zip",
      destination: "/out",
      tmpDir,
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
    const tmpDir = await tmpDirFor("zip-slip");

    const result = await extractArchive({
      storage,
      archivePath: "/evil.zip",
      destination: "/out",
      tmpDir,
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
    const tmpDir = await tmpDirFor("zip-all-evil");

    await expect(
      extractArchive({
        storage,
        archivePath: "/all-evil.zip",
        destination: "/out",
        tmpDir,
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
    const tmpDir = await tmpDirFor("zip-empty");

    await expect(
      extractArchive({
        storage,
        archivePath: "/empty.zip",
        destination: "/out",
        tmpDir,
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow("no entries were extracted");
  });

  it("rejects a corrupt zip file that yauzl cannot open", async () => {
    const storage = createMemoryStorage();
    await storage.upload("/corrupt.zip", Buffer.from("not a zip file at all"));
    const tmpDir = await tmpDirFor("zip-corrupt");

    await expect(
      extractArchive({
        storage,
        archivePath: "/corrupt.zip",
        destination: "/out",
        tmpDir,
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow();
  });

  it("removes the spooled temp file after extracting", async () => {
    const zipBytes = buildRawZip([{ name: "a.txt", content: Buffer.from("a") }]);
    const storage = createMemoryStorage();
    await storage.upload("/a.zip", zipBytes);
    const tmpDir = await tmpDirFor("zip-cleanup");

    await extractArchive({
      storage,
      archivePath: "/a.zip",
      destination: "/out",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(await readdir(tmpDir)).toEqual([]);
  });

  it("enforces the byte cap while spooling and cleans up the temp file", async () => {
    const zipBytes = buildRawZip([{ name: "a.txt", content: Buffer.from("a".repeat(1000)) }]);
    const storage = createMemoryStorage();
    await storage.upload("/big.zip", zipBytes);
    const tmpDir = await tmpDirFor("zip-cap");

    await expect(
      extractArchive({
        storage,
        archivePath: "/big.zip",
        destination: "/out",
        tmpDir,
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: 10,
      }),
    ).rejects.toThrow(ByteCapExceededError);

    expect(await readdir(tmpDir)).toEqual([]);
  });
});

describe("extractArchive: tar", () => {
  it("extracts a plain .tar archive", async () => {
    const tarBuffer = await buildTar([{ name: "a.txt", content: "alpha" }]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar", tarBuffer);
    const tmpDir = await tmpDirFor("tar-basic");

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar",
      destination: "/out",
      tmpDir,
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
    const tmpDir = await tmpDirFor("tar-symlink");

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar",
      destination: "/out",
      tmpDir,
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
    const tmpDir = await tmpDirFor("tar-slip");

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar",
      destination: "/out",
      tmpDir,
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
    const tmpDir = await tmpDirFor("targz-basic");

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar.gz",
      destination: "/out",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result).toEqual({ path: "/out" });
    expect(storage.dump()).toMatchObject({ "/out/a.txt": "alpha" });
  });

  it("extracts a .tar.zst archive (Node 22.15+)", async () => {
    const tarBuffer = await buildTar([{ name: "a.txt", content: "alpha" }]);
    const storage = createMemoryStorage();
    await storage.upload("/a.tar.zst", zstdCompressSync(tarBuffer));
    const tmpDir = await tmpDirFor("tarzst-basic");

    const result = await extractArchive({
      storage,
      archivePath: "/a.tar.zst",
      destination: "/out",
      tmpDir,
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
    const tmpDir = await tmpDirFor("tarzst-unsupported");

    await expect(
      extractArchive({
        storage,
        archivePath: "/a.tar.zst",
        destination: "/out",
        tmpDir,
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
    const tmpDir = await tmpDirFor("targz-cap");

    await expect(
      extractArchive({
        storage,
        archivePath: "/a.tar.gz",
        destination: "/out",
        tmpDir,
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
    const tmpDir = await tmpDirFor("tar-cancel");
    const controller = new AbortController();

    await expect(
      extractArchive({
        storage,
        archivePath: "/two.tar",
        destination: "/out",
        tmpDir,
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
    const tmpDir = await tmpDirFor("bare-gz");

    const result = await extractArchive({
      storage,
      archivePath: "/notes.txt.gz",
      destination: "/out",
      tmpDir,
      signal: new AbortController().signal,
      report: () => {},
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result).toEqual({ path: "/out" });
    expect(storage.dump()).toMatchObject({ "/out/notes.txt": "hello world" });
  });

  it("enforces the byte cap", async () => {
    const storage = createMemoryStorage();
    await storage.upload("/big.txt.gz", gzipSync(Buffer.from("x".repeat(5000))));
    const tmpDir = await tmpDirFor("bare-gz-cap");

    await expect(
      extractArchive({
        storage,
        archivePath: "/big.txt.gz",
        destination: "/out",
        tmpDir,
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: 10,
      }),
    ).rejects.toThrow();
  });
});

describe("extractArchive: format detection", () => {
  it("rejects an archive path with no recognized extension", async () => {
    const storage = createMemoryStorage();
    await storage.upload("/mystery.xyz", Buffer.from("data"));
    const tmpDir = await tmpDirFor("unknown-ext");

    await expect(
      extractArchive({
        storage,
        archivePath: "/mystery.xyz",
        destination: "/out",
        tmpDir,
        signal: new AbortController().signal,
        report: () => {},
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    ).rejects.toThrow(/unsupported/);
  });
});
