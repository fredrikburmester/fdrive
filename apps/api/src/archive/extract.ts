import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Readable, Transform } from "node:stream";
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
  ByteCapExceededError,
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
  /** Maximum archive entries inspected. Defaults to `DEFAULT_EXTRACT_MAX_ENTRIES`. */
  readonly maxEntries?: number;
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

/** Bounds parser and upload work from archives containing huge numbers of tiny entries. */
export const DEFAULT_EXTRACT_MAX_ENTRIES = 100_000;

export class ArchiveEntryCapExceededError extends Error {
  constructor(maxEntries: number) {
    super(`exceeded the maximum of ${maxEntries} entries allowed for this job`);
    this.name = "ArchiveEntryCapExceededError";
  }
}

interface ExtractionLimits {
  noteEntry(): void;
  noteDeclaredFileSize(size: number): void;
  noteExpandedBytes(bytes: number): void;
}

function createExtractionLimits(maxBytes: number, maxEntries: number): ExtractionLimits {
  let expandedBytes = 0;
  let declaredFileBytes = 0;
  let entries = 0;
  return {
    noteEntry() {
      entries += 1;
      if (entries > maxEntries) {
        throw new ArchiveEntryCapExceededError(maxEntries);
      }
    },
    noteDeclaredFileSize(size) {
      declaredFileBytes += size;
      if (declaredFileBytes > maxBytes) {
        throw new ByteCapExceededError(maxBytes);
      }
    },
    noteExpandedBytes(bytes) {
      expandedBytes += bytes;
      if (expandedBytes > maxBytes) {
        throw new ByteCapExceededError(maxBytes);
      }
    },
  };
}

function capStreamBytes(source: Readable, maxBytes: number): Readable {
  let bytes = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new ByteCapExceededError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
  source.once("error", (error) => capped.destroy(error));
  capped.once("error", () => source.destroy());
  source.pipe(capped);
  return capped;
}

/**
 * Caps one upload while sharing the expanded-byte budget across all archive entries.
 * Closing either side closes the other, so a rejected upload or limit error cannot
 * leave its archive reader/decompressor running in the background.
 */
async function uploadCappedEntry(
  storage: StorageProvider,
  target: string,
  entryStream: Readable,
  opts: { mkdirParents: true; signal: AbortSignal; contentLength?: number },
  limits: ExtractionLimits,
): Promise<void> {
  const capped = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        limits.noteExpandedBytes(chunk.length);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  entryStream.once("error", (error) => capped.destroy(error));
  capped.once("error", () => entryStream.destroy());
  entryStream.pipe(capped);

  try {
    await storage.upload(target, webStreamFromNodeReadable(capped), opts);
  } catch (error) {
    entryStream.destroy();
    capped.destroy();
    throw error;
  }
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
  limits: ExtractionLimits,
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
      limits.noteEntry();
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

      limits.noteDeclaredFileSize(entry.uncompressedSize);
      const readStream = await openZipEntryStream(zipfile, entry);
      await uploadCappedEntry(
        storage,
        target,
        readStream,
        { mkdirParents: true, contentLength: entry.uncompressedSize, signal },
        limits,
      );
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
  limits: ExtractionLimits,
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
      return await walkZipEntries(zipfile, storage, destination, signal, report, limits);
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
  limits: ExtractionLimits,
): Promise<void> {
  throwIfAborted(signal);
  limits.noteEntry();

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
  limits.noteDeclaredFileSize(header.size ?? 0);
  try {
    await storage.upload(target, webStreamFromNodeReadable(entryStream), uploadOpts);
  } catch (error) {
    entryStream.destroy();
    throw error;
  }
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
  limits: ExtractionLimits,
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
  const expandedSource = capStreamBytes(source, maxBytes);
  const extractStream = tar.extract();
  expandedSource.once("error", (err) => extractStream.destroy(err));
  expandedSource.pipe(extractStream);

  const skipped: string[] = [];
  const counters = { written: 0, processed: 0 };

  const stopStreams = () => {
    nodeStream.destroy();
    decompressor?.destroy();
    expandedSource.destroy();
    extractStream.destroy();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          stopStreams();
          reject(error);
        }
      };

      nodeStream.on("error", fail);
      if (decompressor) {
        decompressor.on("error", fail);
      }
      expandedSource.on("error", fail);
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
            limits,
          ).then(
            () => next(),
            (error: unknown) => next(error),
          );
        },
      );
    });
  } finally {
    stopStreams();
  }

  return { written: counters.written, skipped };
}

async function extractPlainGzip(
  storage: StorageProvider,
  archivePath: string,
  destination: string,
  signal: AbortSignal,
  report: ReportProgress,
  maxBytes: number,
  limits: ExtractionLimits,
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

  limits.noteEntry();
  try {
    await uploadCappedEntry(storage, target, outputStream, { mkdirParents: true, signal }, limits);
  } finally {
    nodeStream.destroy();
    gunzip.destroy();
  }
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
 * but unsupported, when more than `maxBytes` compressed or expanded bytes
 * would be read, or when the archive contains too many entries.
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
  const limits = createExtractionLimits(
    opts.maxBytes,
    opts.maxEntries ?? DEFAULT_EXTRACT_MAX_ENTRIES,
  );

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
        limits,
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
        limits,
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
        limits,
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
        limits,
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
        limits,
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
