import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat as fsStat, rm } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { createGzip, createZstdCompress } from "node:zlib";
import {
  type ArchiveFormat,
  archiveExtensionFor,
  baseName,
  isStorageError,
  type StorageProvider,
} from "@fdrive/core";
import * as tar from "tar-stream";
import { ZipFile } from "yazl";
import type { ReportProgress } from "../jobs/types.js";
import {
  countingTransform,
  isPrecompressedEntry,
  isZstdSupported,
  nodeReadableFromWeb,
  throwIfAborted,
} from "./stream-utils.js";

/** Thrown when `format` is not supported by this server's Node runtime. */
export class UnsupportedFormatError extends Error {
  constructor(format: string) {
    super(`${format} unsupported on this server`);
    this.name = "UnsupportedFormatError";
  }
}

export interface CompressToTempOptions {
  readonly storage: StorageProvider;
  /** The selection to archive; every file and folder is walked recursively. */
  readonly paths: readonly string[];
  readonly format: ArchiveFormat;
  readonly tmpDir: string;
  readonly signal: AbortSignal;
  readonly report: ReportProgress;
  /**
   * Overrides whether `tar.zst` is supported, for tests. Defaults to
   * checking whether `node:zlib` exposes `createZstdCompress` on this
   * runtime (Node 22.15+).
   */
  readonly zstdSupported?: boolean;
}

export interface CompressResult {
  readonly file: string;
  readonly size: number;
}

interface CollectedFile {
  readonly path: string;
  readonly entryName: string;
  readonly size: number;
  readonly modifiedAt: Date;
}

/**
 * Recursively walks `paths` (each resolved through `collectPath`, since
 * their kind is not yet known) building the flat list of files to archive.
 * Entry names are prefixed with each top-level path's own base name, so a
 * folder's contents nest under its own name in the resulting archive.
 */
async function collectFiles(
  storage: StorageProvider,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<CollectedFile[]> {
  const files: CollectedFile[] = [];
  for (const path of paths) {
    await collectPath(storage, path, baseName(path), files, signal);
  }
  return files;
}

/**
 * Resolves a top-level compress selection, whose kind (file or directory)
 * fdrive does not already know, and adds it (or its contents) to `out`.
 *
 * Tries `statFile` (a `HEAD`) first, not `list` (a `GET` to SFTPGo's `dirs`
 * endpoint): `statFile` is safe for every outcome here, since it returns
 * the file's stat directly on success or a clean `bad_request` when `path`
 * is actually a directory. Calling `list` directly on a path that turns
 * out to be a plain file would do the same job against the in-memory fake
 * server this is tested against, but a real SFTPGo server (verified
 * against v2.7.5) drops the connection outright in that case instead of
 * responding with a clean error, which surfaces to callers as an
 * indistinguishable-from-a-real-outage "fetch failed", failing the whole
 * compress job. Only once `statFile` has ruled out `path` being a file
 * does this fall through to `collectDirectory`, which lists it.
 */
async function collectPath(
  storage: StorageProvider,
  path: string,
  entryName: string,
  out: CollectedFile[],
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  try {
    const stat = await storage.statFile(path);
    out.push({ path, entryName, size: stat.size, modifiedAt: stat.modifiedAt ?? new Date(0) });
    return;
  } catch (error) {
    if (!isStorageError(error) || error.kind !== "bad_request") {
      throw error;
    }
  }

  await collectDirectory(storage, path, entryName, out, signal);
}

/**
 * Lists `path` (already known to be a directory, either because
 * `collectPath` ruled out it being a file, or because a parent `list` call
 * already reported it as a `dir` entry) and recurses into every child.
 */
async function collectDirectory(
  storage: StorageProvider,
  path: string,
  entryName: string,
  out: CollectedFile[],
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  const children = await storage.list(path);
  for (const child of children) {
    // Compressing the root ("/") itself gives every top-level entry an
    // empty `entryName` prefix; without this guard the joined name would
    // start with a leading "/", which yazl's own validation rejects as an
    // absolute path.
    const childEntryName = entryName.length > 0 ? `${entryName}/${child.name}` : child.name;
    if (child.kind === "dir") {
      await collectDirectory(storage, child.path, childEntryName, out, signal);
    } else if (child.kind === "file") {
      out.push({
        path: child.path,
        entryName: childEntryName,
        size: child.size,
        modifiedAt: child.modifiedAt,
      });
    }
    // Symlinks and other kinds are not archived: SFTPGo's own zip endpoint
    // has the same restriction and there is no safe, provider-neutral way
    // to resolve them here.
  }
}

async function writeZip(
  files: readonly CollectedFile[],
  storage: StorageProvider,
  destPath: string,
  signal: AbortSignal,
  report: ReportProgress,
): Promise<void> {
  const zipfile = new ZipFile();
  const outStream = createWriteStream(destPath);
  zipfile.outputStream.pipe(outStream);
  const outFinished = finished(outStream);

  let processed = 0;
  let bytes = 0;
  for (const file of files) {
    throwIfAborted(signal);
    const download = await storage.download(file.path, { signal });
    const nodeStream = nodeReadableFromWeb(download.body);
    // `addReadStream` reads lazily, only once its internal queue reaches
    // this entry (it writes entries to the zip strictly in order), so this
    // stream may sit unread for a while. Piping through `countingTransform`
    // rather than attaching a `data` listener directly to `nodeStream`
    // matters here: a `data` listener would resume `nodeStream` into
    // flowing mode immediately and drain it before yazl ever reads it,
    // losing the entry's contents. The transform instead buffers safely in
    // paused mode until yazl actually pulls from it.
    const counted = nodeStream.pipe(
      countingTransform((n) => {
        bytes += n;
        report({ bytes });
      }),
    );

    await new Promise<void>((resolve, reject) => {
      nodeStream.once("error", reject);
      counted.once("error", reject);
      counted.once("end", resolve);
      zipfile.addReadStream(counted, file.entryName, {
        mtime: file.modifiedAt,
        compress: !isPrecompressedEntry(file.entryName),
      });
    });

    processed += 1;
    report({ processed, total: files.length, bytes });
  }

  zipfile.end();
  await outFinished;
}

async function writeTar(
  files: readonly CollectedFile[],
  storage: StorageProvider,
  destPath: string,
  signal: AbortSignal,
  report: ReportProgress,
  compression: "gzip" | "zstd",
): Promise<void> {
  const pack = tar.pack();
  const outStream = createWriteStream(destPath);
  const compressor = compression === "gzip" ? createGzip() : createZstdCompress();
  pack.pipe(compressor).pipe(outStream);
  const outFinished = finished(outStream);

  let processed = 0;
  let bytes = 0;
  for (const file of files) {
    throwIfAborted(signal);
    const download = await storage.download(file.path, { signal });
    const nodeStream = nodeReadableFromWeb(download.body);
    const counted = nodeStream.pipe(
      countingTransform((n) => {
        bytes += n;
        report({ bytes });
      }),
    );

    const entryStream = pack.entry({
      name: file.entryName,
      size: file.size,
      mtime: file.modifiedAt,
    });
    await new Promise<void>((resolve, reject) => {
      nodeStream.once("error", reject);
      counted.once("error", reject);
      entryStream.once("error", reject);
      entryStream.once("finish", resolve);
      counted.pipe(entryStream);
    });

    processed += 1;
    report({ processed, total: files.length, bytes });
  }

  pack.finalize();
  await outFinished;
}

/**
 * Builds an archive of `paths` in `format` at a temp file under `tmpDir`,
 * streaming every file from `storage` and never buffering a whole file in
 * memory. Removes the temp file and rethrows on any failure (including
 * cancellation via `signal`), so callers never need to clean up themselves
 * except on success.
 */
export async function compressToTemp(opts: CompressToTempOptions): Promise<CompressResult> {
  const zstdSupported = opts.zstdSupported ?? isZstdSupported();
  if (opts.format === "tar.zst" && !zstdSupported) {
    throw new UnsupportedFormatError("tar.zst");
  }

  throwIfAborted(opts.signal);
  const files = await collectFiles(opts.storage, opts.paths, opts.signal);
  opts.report({ processed: 0, total: files.length, bytes: 0 });

  const tempFile = join(
    opts.tmpDir,
    `fdrive-compress-${randomUUID()}${archiveExtensionFor(opts.format)}`,
  );

  try {
    if (opts.format === "zip") {
      await writeZip(files, opts.storage, tempFile, opts.signal, opts.report);
    } else {
      await writeTar(
        files,
        opts.storage,
        tempFile,
        opts.signal,
        opts.report,
        opts.format === "tar.gz" ? "gzip" : "zstd",
      );
    }
    const stat = await fsStat(tempFile);
    return { file: tempFile, size: stat.size };
  } catch (error) {
    await rm(tempFile, { force: true });
    throw error;
  }
}
