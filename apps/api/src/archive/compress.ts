import type { Readable } from "node:stream";
import { pipeline } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import { createGzip, createZstdCompress } from "node:zlib";
import { type ArchiveFormat, baseName, type StorageProvider } from "@fdrive/core";
import * as tar from "tar-stream";
import type { ReportProgress } from "../jobs/types.js";
import {
  countingTransform,
  isZstdSupported,
  nodeReadableFromWeb,
  throwIfAborted,
  webStreamFromNodeReadable,
} from "./stream-utils.js";

/** Thrown when `format` is not supported by this server's Node runtime. */
export class UnsupportedFormatError extends Error {
  constructor(format: string) {
    super(`${format} unsupported on this server`);
    this.name = "UnsupportedFormatError";
  }
}

export interface CompressOptions {
  readonly storage: StorageProvider;
  /** The selection to archive; every file and folder is walked recursively. */
  readonly paths: readonly string[];
  readonly format: ArchiveFormat;
  /** Where the archive goes: a new file, never one that is already there. */
  readonly target: string;
  readonly signal: AbortSignal;
  readonly report: ReportProgress;
  /**
   * Overrides whether `tar.zst` is supported, for tests. Defaults to
   * checking whether `node:zlib` exposes `createZstdCompress` on this
   * runtime (Node 22.15+).
   */
  readonly zstdSupported?: boolean;
}

interface CollectedFile {
  readonly path: string;
  readonly entryName: string;
  readonly size: number;
  readonly modifiedAt: Date;
}

/** An archive being written. */
interface Archive {
  readonly body: ReadableStream<Uint8Array>;
  /** What failed while writing it, when that is more than its stream reports. */
  failure(): unknown;
  /** Settles once nothing is writing it any more. */
  readonly stopped: Promise<void>;
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
 */
async function collectPath(
  storage: StorageProvider,
  path: string,
  entryName: string,
  out: CollectedFile[],
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  const stat = await storage.stat(path);
  if (stat.kind === "file") {
    out.push({ path, entryName, size: stat.size, modifiedAt: stat.modifiedAt ?? new Date(0) });
    return;
  }

  await collectDirectory(storage, path, entryName, out, signal);
}

/**
 * Lists `path` (already known not to be a file, either because
 * `collectPath` stat'd it, or because a parent `list` call reported it as a
 * `dir` entry) and recurses into every child.
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
    // start with a leading "/".
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
    // Symlinks and other kinds are not archived: there is no safe,
    // provider-neutral way to resolve them here.
  }
}

/** A zip from the storage's own zip writer, which reports how far it has got. */
async function zipArchive(opts: CompressOptions): Promise<Archive> {
  if (opts.storage.zip === undefined) throw new UnsupportedFormatError("zip");
  const body = await opts.storage.zip(opts.paths, {
    signal: opts.signal,
    onProgress: opts.report,
  });
  return { body, failure: () => undefined, stopped: Promise.resolve() };
}

/**
 * A compressed tar of `paths`, read file by file from `storage` as the
 * archive is read. Once its reader goes away, the file being read is
 * cancelled and nothing more is read. A file that fails ends the stream as
 * a premature close, so the failure itself is kept for `failure`.
 */
async function tarArchive(opts: CompressOptions, compression: "gzip" | "zstd"): Promise<Archive> {
  const files = await collectFiles(opts.storage, opts.paths, opts.signal);
  opts.report({ processed: 0, total: files.length, bytes: 0 });
  const stop = new AbortController();
  const signal = AbortSignal.any([opts.signal, stop.signal]);
  const pack = tar.pack();
  const compressor = compression === "gzip" ? createGzip() : createZstdCompress();
  const output: Readable = pipeline(pack, compressor, () => stop.abort());
  let failure: unknown;
  const stopped = (async () => {
    let processed = 0;
    let bytes = 0;
    for (const file of files) {
      throwIfAborted(signal);
      const download = await opts.storage.download(file.path, { signal });
      const counted = countingTransform((n) => {
        bytes += n;
        opts.report({ bytes });
      });
      const entry = pack.entry({ name: file.entryName, size: file.size, mtime: file.modifiedAt });
      await pipelineAsync(nodeReadableFromWeb(download.body), counted, entry, { signal });
      processed += 1;
      opts.report({ processed, total: files.length, bytes });
    }
    pack.finalize();
  })().catch((error: unknown) => {
    failure = error;
    output.destroy(error as Error);
  });
  return { body: webStreamFromNodeReadable(output), failure: () => failure, stopped };
}

/**
 * Archives `paths` into a new file at `target`, writing the archive as it
 * is read: it streams straight into `storage.upload`, which publishes the
 * file only once it is whole and refuses a name that is taken. A failure
 * or cancellation leaves nothing at `target` and rejects with what stopped
 * the archive, or else with the upload's own refusal.
 */
export async function compress(opts: CompressOptions): Promise<void> {
  const zstdSupported = opts.zstdSupported ?? isZstdSupported();
  if (opts.format === "tar.zst" && !zstdSupported) {
    throw new UnsupportedFormatError("tar.zst");
  }
  throwIfAborted(opts.signal);

  const archive =
    opts.format === "zip"
      ? await zipArchive(opts)
      : await tarArchive(opts, opts.format === "tar.gz" ? "gzip" : "zstd");
  // Storage reports a body that failed under the target's name; the job
  // reports what actually stopped the archive.
  let failed: { readonly error: unknown } | undefined;
  const reader = archive.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await reader.read().catch((error: unknown) => {
          failed = { error };
          throw error;
        });
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    // Nothing is read until the upload asks, so a refused upload reads nothing.
    { highWaterMark: 0 },
  );
  try {
    await opts.storage.upload(opts.target, body, { overwrite: false, signal: opts.signal });
  } catch (error) {
    // Refused before it read anything (the name is taken): stop the archive too.
    await body.cancel(error).catch(() => undefined);
    throw failed === undefined ? error : (archive.failure() ?? failed.error);
  } finally {
    await archive.stopped;
  }
}
