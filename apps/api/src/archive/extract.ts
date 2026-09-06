import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { createGunzip, createZstdDecompress } from "node:zlib";
import {
  baseName,
  detectArchiveKind,
  joinPath,
  type StorageProvider,
  safeEntryPath,
  stripArchiveExtension,
} from "@fdrive/core";
import * as tar from "tar-stream";
import * as yauzl from "yauzl";
import type { ReportProgress } from "../jobs/types.js";
import { UnsupportedFormatError } from "./compress.js";
import {
  enforceByteCap,
  isZstdSupported,
  nodeReadableFromWeb,
  throwIfAborted,
  webStreamFromNodeReadable,
} from "./stream-utils.js";

export interface ExtractArchiveOptions {
  readonly storage: StorageProvider;
  readonly archivePath: string;
  readonly destination: string;
  readonly tmpDir: string;
  readonly signal: AbortSignal;
  readonly report: ReportProgress;
  readonly maxBytes: number;
  /** Overrides whether `tar.zst` is supported, for tests. */
  readonly zstdSupported?: boolean;
}

export interface ExtractResult {
  readonly path: string;
  readonly warning?: string;
}

interface EntryOutcome {
  readonly written: number;
  readonly skipped: readonly string[];
}

function summarizeSkipped(skipped: readonly string[]): string | undefined {
  if (skipped.length === 0) {
    return undefined;
  }
  const noun = skipped.length === 1 ? "entry" : "entries";
  return `skipped ${skipped.length} unsafe ${noun}: ${skipped.join(", ")}`;
}

function openZipFile(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // `decodeStrings: false` disables yauzl's own entry-name validation
    // (which unconditionally rejects a ".." segment or an absolute path by
    // erroring the whole zip, not just that entry). fdrive does its own,
    // per-entry validation with `safeEntryPath` below instead, reading the
    // raw name straight from `entry.fileNameRaw`.
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: true, decodeStrings: false },
      (err, zipfile) => {
        if (err || !zipfile) {
          reject(err ?? new Error("failed to open zip"));
          return;
        }
        resolve(zipfile);
      },
    );
  });
}

/** The entry's name, decoded from `fileNameRaw` rather than `fileName` (see `openZipFile`). */
function rawEntryName(entry: yauzl.Entry): string {
  return entry.fileNameRaw.toString("utf8");
}

function openZipEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error("failed to open zip entry"));
        return;
      }
      resolve(stream);
    });
  });
}

async function walkZipEntries(
  zipfile: yauzl.ZipFile,
  storage: StorageProvider,
  destination: string,
  signal: AbortSignal,
  report: ReportProgress,
): Promise<EntryOutcome> {
  const skipped: string[] = [];
  let written = 0;
  let processed = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    zipfile.on("error", fail);
    zipfile.on("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zipfile.on("entry", (entry: yauzl.Entry) => {
      handleEntry(entry).catch(fail);
    });
    zipfile.readEntry();

    async function handleEntry(entry: yauzl.Entry): Promise<void> {
      throwIfAborted(signal);
      const entryName = rawEntryName(entry);

      if (entryName.endsWith("/")) {
        zipfile.readEntry();
        return;
      }

      const target = safeEntryPath(destination, entryName);
      if (target === null) {
        skipped.push(entryName);
        zipfile.readEntry();
        return;
      }

      const readStream = await openZipEntryStream(zipfile, entry);
      await storage.upload(target, webStreamFromNodeReadable(readStream), {
        mkdirParents: true,
        contentLength: entry.uncompressedSize,
        signal,
      });
      written += 1;
      processed += 1;
      report({ processed });
      zipfile.readEntry();
    }
  });

  return { written, skipped };
}

async function extractZip(
  storage: StorageProvider,
  archivePath: string,
  destination: string,
  tmpDir: string,
  signal: AbortSignal,
  report: ReportProgress,
  maxBytes: number,
): Promise<EntryOutcome> {
  const spoolPath = join(tmpDir, `fdrive-extract-${randomUUID()}.zip`);
  try {
    const download = await storage.download(archivePath, { signal });
    const nodeStream = nodeReadableFromWeb(download.body);
    enforceByteCap(nodeStream, maxBytes, (bytes) => report({ bytes }));

    const outStream = createWriteStream(spoolPath);
    await new Promise<void>((resolve, reject) => {
      // `.pipe()` alone does not forward a source error to its
      // destination, so without this explicit listener a byte-cap
      // destroy() on `nodeStream` would leave `outStream` (and this
      // promise) hanging forever instead of rejecting.
      nodeStream.once("error", reject);
      outStream.once("error", reject);
      outStream.once("finish", resolve);
      nodeStream.pipe(outStream);
    });

    const zipfile = await openZipFile(spoolPath);
    try {
      return await walkZipEntries(zipfile, storage, destination, signal, report);
    } finally {
      zipfile.close();
    }
  } finally {
    await rm(spoolPath, { force: true });
  }
}

async function handleTarEntry(
  header: tar.Headers,
  entryStream: Readable,
  storage: StorageProvider,
  destination: string,
  signal: AbortSignal,
  report: ReportProgress,
  skipped: string[],
  counters: { written: number; processed: number },
): Promise<void> {
  throwIfAborted(signal);

  if (header.type !== "file") {
    // Directories are implied by their files' `mkdirParents` upload below;
    // symlinks and every other tar entry type are not archived at all.
    entryStream.resume();
    return;
  }

  const target = safeEntryPath(destination, header.name);
  if (target === null) {
    skipped.push(header.name);
    entryStream.resume();
    return;
  }

  const uploadOpts: { mkdirParents: true; signal: AbortSignal; contentLength?: number } = {
    mkdirParents: true,
    signal,
    ...(header.size !== undefined ? { contentLength: header.size } : {}),
  };
  await storage.upload(target, webStreamFromNodeReadable(entryStream), uploadOpts);
  counters.written += 1;
  counters.processed += 1;
  report({ processed: counters.processed });
}

async function extractTar(
  storage: StorageProvider,
  archivePath: string,
  destination: string,
  signal: AbortSignal,
  report: ReportProgress,
  maxBytes: number,
  decompress: "none" | "gzip" | "zstd",
): Promise<EntryOutcome> {
  const download = await storage.download(archivePath, { signal });
  const nodeStream = nodeReadableFromWeb(download.body);
  enforceByteCap(nodeStream, maxBytes, (bytes) => report({ bytes }));

  const decompressor =
    decompress === "gzip" ? createGunzip() : decompress === "zstd" ? createZstdDecompress() : null;
  if (decompressor) {
    // See the comment in `extractPlainGzip`: `.pipe()` never forwards a
    // source error to its destination on its own.
    nodeStream.once("error", (err) => decompressor.destroy(err));
  }
  const source = decompressor ? nodeStream.pipe(decompressor) : nodeStream;
  const extractStream = tar.extract();
  source.once("error", (err) => extractStream.destroy(err));
  source.pipe(extractStream);

  const skipped: string[] = [];
  const counters = { written: 0, processed: 0 };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    nodeStream.on("error", fail);
    if (decompressor) {
      decompressor.on("error", fail);
    }
    extractStream.on("error", fail);
    extractStream.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    extractStream.on(
      "entry",
      (header: tar.Headers, entryStream: Readable, next: (error?: unknown) => void) => {
        handleTarEntry(
          header,
          entryStream,
          storage,
          destination,
          signal,
          report,
          skipped,
          counters,
        ).then(
          () => next(),
          (error: unknown) => next(error),
        );
      },
    );
  });

  return { written: counters.written, skipped };
}

async function extractPlainGzip(
  storage: StorageProvider,
  archivePath: string,
  destination: string,
  signal: AbortSignal,
  report: ReportProgress,
  maxBytes: number,
): Promise<EntryOutcome> {
  const download = await storage.download(archivePath, { signal });
  const nodeStream = nodeReadableFromWeb(download.body);
  enforceByteCap(nodeStream, maxBytes, (bytes) => report({ bytes }));

  const gunzip = createGunzip();
  // `.pipe()` does not forward a source error to its destination: without
  // this, a byte-cap destroy() on `nodeStream` would leave `gunzip` (and
  // the upload reading from it below) waiting forever instead of failing.
  nodeStream.once("error", (err) => gunzip.destroy(err));
  const outputStream = nodeStream.pipe(gunzip);
  const targetName = stripArchiveExtension(baseName(archivePath));
  const target = joinPath(destination, targetName);

  await storage.upload(target, webStreamFromNodeReadable(outputStream), {
    mkdirParents: true,
    signal,
  });
  report({ processed: 1 });
  return { written: 1, skipped: [] };
}

/**
 * Extracts the archive at `archivePath` into `destination`. `zip` is
 * spooled to a temp file first (random access is required to read its
 * central directory); every other supported kind streams straight from
 * `storage.download`. Every entry path is resolved through `safeEntryPath`;
 * entries that fail it are skipped and listed in the returned `warning`.
 * Symlinks in tar archives are always skipped. Throws when nothing could be
 * extracted (an empty or entirely unsafe archive), when `archivePath`'s
 * extension is not a recognized archive kind, when `tar.zst` is requested
 * but unsupported, or when more than `maxBytes` would be read.
 */
export async function extractArchive(opts: ExtractArchiveOptions): Promise<ExtractResult> {
  const kind = detectArchiveKind(opts.archivePath);
  if (kind === null) {
    throw new UnsupportedFormatError(baseName(opts.archivePath));
  }

  const zstdSupported = opts.zstdSupported ?? isZstdSupported();
  if (kind === "tar.zst" && !zstdSupported) {
    throw new UnsupportedFormatError("tar.zst");
  }

  throwIfAborted(opts.signal);
  opts.report({ processed: 0, total: null, bytes: 0 });

  let outcome: EntryOutcome;
  switch (kind) {
    case "zip":
      outcome = await extractZip(
        opts.storage,
        opts.archivePath,
        opts.destination,
        opts.tmpDir,
        opts.signal,
        opts.report,
        opts.maxBytes,
      );
      break;
    case "tar":
      outcome = await extractTar(
        opts.storage,
        opts.archivePath,
        opts.destination,
        opts.signal,
        opts.report,
        opts.maxBytes,
        "none",
      );
      break;
    case "tar.gz":
      outcome = await extractTar(
        opts.storage,
        opts.archivePath,
        opts.destination,
        opts.signal,
        opts.report,
        opts.maxBytes,
        "gzip",
      );
      break;
    case "tar.zst":
      outcome = await extractTar(
        opts.storage,
        opts.archivePath,
        opts.destination,
        opts.signal,
        opts.report,
        opts.maxBytes,
        "zstd",
      );
      break;
    case "gz":
      outcome = await extractPlainGzip(
        opts.storage,
        opts.archivePath,
        opts.destination,
        opts.signal,
        opts.report,
        opts.maxBytes,
      );
      break;
  }

  if (outcome.written === 0) {
    const suffix = summarizeSkipped(outcome.skipped);
    throw new Error(
      suffix !== undefined ? `no entries were extracted (${suffix})` : "no entries were extracted",
    );
  }

  const warning = summarizeSkipped(outcome.skipped);
  return warning !== undefined ? { path: opts.destination, warning } : { path: opts.destination };
}
