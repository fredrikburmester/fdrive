import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat as fsStat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
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

type Completion = { ok: true } | { ok: false; error: unknown };

/** Observe rejection immediately, including while another archive entry is awaited. */
function observe(promise: Promise<void>, controller: AbortController): Promise<Completion> {
  return promise.then(
    () => ({ ok: true }),
    (error: unknown) => {
      controller.abort(error);
      return { ok: false, error };
    },
  );
}

function requireCompleted(result: Completion): void {
  if (!result.ok) throw result.error;
}

/** Yazl's private pipe chain exposes each upstream source through public unpipe events. */
function cancelZipSources(
  output: NodeJS.ReadableStream,
  controller: AbortController,
  signal: AbortSignal,
): Promise<Completion>[] {
  const closed: Promise<Completion>[] = [];
  const watched = new WeakSet<NodeJS.ReadableStream>();
  function watch(stream: NodeJS.ReadableStream): void {
    watched.add(stream);
    stream.on("unpipe", (source: Readable) => {
      if (!signal.aborted || watched.has(source)) return;
      watch(source);
      closed.push(observe(finished(source, { cleanup: true }), controller));
      source.destroy();
    });
  }
  watch(output);
  return closed;
}

async function writeZip(
  files: readonly CollectedFile[],
  storage: StorageProvider,
  destPath: string,
  signal: AbortSignal,
  report: ReportProgress,
): Promise<void> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const zipfile = new ZipFile();
  const outStream = createWriteStream(destPath);
  const privateStreams = cancelZipSources(zipfile.outputStream, controller, combined);
  zipfile.on("error", (error: unknown) => controller.abort(error));
  const outFinished = observe(
    pipeline(zipfile.outputStream, outStream, { signal: combined }),
    controller,
  );
  let inputFinished: Promise<Completion> | undefined;
  try {
    let processed = 0;
    let bytes = 0;
    for (const file of files) {
      throwIfAborted(combined);
      const download = await storage.download(file.path, { signal: combined });
      const nodeStream = nodeReadableFromWeb(download.body);
      const counted = countingTransform((n) => {
        bytes += n;
        report({ bytes });
      });
      // Wait for consumption as well as writing, since yazl pulls entries lazily.
      const consumed = observe(finished(counted, { cleanup: true }), controller);
      inputFinished = observe(pipeline(nodeStream, counted, { signal: combined }), controller);
      zipfile.addReadStream(counted, file.entryName, {
        mtime: file.modifiedAt,
        compress: !isPrecompressedEntry(file.entryName),
      });
      requireCompleted(await consumed);
      requireCompleted(await inputFinished);
      processed += 1;
      report({ processed, total: files.length, bytes });
    }
    throwIfAborted(combined);
    zipfile.end();
    requireCompleted(await outFinished);
  } catch (error) {
    throw combined.aborted ? combined.reason : error;
  } finally {
    controller.abort();
    await inputFinished;
    await outFinished;
    // Destroying one destination can expose another source on its close event.
    for (let index = 0; index < privateStreams.length; index++) await privateStreams[index];
  }
}

async function writeTar(
  files: readonly CollectedFile[],
  storage: StorageProvider,
  destPath: string,
  signal: AbortSignal,
  report: ReportProgress,
  compression: "gzip" | "zstd",
): Promise<void> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const pack = tar.pack();
  const outStream = createWriteStream(destPath);
  const compressor = compression === "gzip" ? createGzip() : createZstdCompress();
  const outFinished = observe(
    pipeline(pack, compressor, outStream, { signal: combined }),
    controller,
  );
  let inputFinished: Promise<Completion> | undefined;
  try {
    let processed = 0;
    let bytes = 0;
    for (const file of files) {
      throwIfAborted(combined);
      const download = await storage.download(file.path, { signal: combined });
      const nodeStream = nodeReadableFromWeb(download.body);
      const counted = countingTransform((n) => {
        bytes += n;
        report({ bytes });
      });
      const entryStream = pack.entry({
        name: file.entryName,
        size: file.size,
        mtime: file.modifiedAt,
      });
      inputFinished = observe(
        pipeline(nodeStream, counted, entryStream, { signal: combined }),
        controller,
      );
      requireCompleted(await inputFinished);
      processed += 1;
      report({ processed, total: files.length, bytes });
    }
    throwIfAborted(combined);
    pack.finalize();
    requireCompleted(await outFinished);
  } catch (error) {
    throw combined.aborted ? combined.reason : error;
  } finally {
    controller.abort();
    await inputFinished;
    await outFinished;
  }
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
