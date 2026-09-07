import { baseName, detectArchiveKind, type StorageProvider } from "@fdrive/core";
import { boundPeekEntries, type PeekEntry, sortPeekEntries } from "./peek-entry.js";
import { collectTarPeekEntries, tarCompressionFor } from "./peek-tar.js";
import {
  CorruptZipCentralDirectoryError,
  locateZipCentralDirectory,
  parseZipCentralDirectoryEntries,
} from "./peek-zip.js";
import { isZstdSupported } from "./stream-utils.js";

/** The number of entries `GET /fs/archive-entries` ever returns; more than
 * this and the response is `truncated` instead. */
export const PEEK_MAX_ENTRIES = 5000;
/**
 * Upper bound on the central directory the zip path is willing to fetch. The size
 * comes from the archive's own end-of-central-directory record, so a crafted file
 * could otherwise make the API read and buffer gigabytes; 5000 entries with long
 * names fit comfortably in far less than this.
 */
export const PEEK_MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;

/** How many trailing bytes of a zip are read to find its end-of-central-directory record. */
export const PEEK_TAIL_READ_BYTES = 64 * 1024;

export type PeekArchiveFormat = "zip" | "tar" | "tar.gz" | "tar.zst";

export interface PeekArchiveResult {
  readonly format: PeekArchiveFormat;
  readonly entries: PeekEntry[];
  readonly truncated: boolean;
}

/** Thrown when `path`'s extension is not one `peekArchive` reads (including
 * a bare `.gz`, which has no listable entries of its own, and a `tar.zst`
 * on a Node runtime that does not support zstd). */
export class UnsupportedPeekFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPeekFormatError";
  }
}

/** Thrown when `path` has a recognized archive extension but its bytes do
 * not decode as that format. */
export class UnreadableArchiveError extends Error {
  constructor() {
    super("not a readable archive");
    this.name = "UnreadableArchiveError";
  }
}

export interface PeekArchiveOptions {
  readonly storage: StorageProvider;
  readonly path: string;
  /** Cap on bytes read for the tar family's streaming scan. Unused for
   * zip, whose two Range reads are already bounded by its own metadata. */
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  /** Overrides whether `tar.zst` is supported, for tests. Defaults to `isZstdSupported()`. */
  readonly zstdSupported?: boolean;
}

/** Reads a whole (already Range-bounded) `ReadableStream` into one `Buffer`. */
async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function withSignal(
  signal: AbortSignal | undefined,
): { signal: AbortSignal } | Record<string, never> {
  return signal !== undefined ? { signal } : {};
}

/**
 * Reads a zip's entries with exactly two Range reads: the last
 * `PEEK_TAIL_READ_BYTES` (or the whole file, if smaller) to find the
 * end-of-central-directory record, then exactly the central directory it
 * points at. Never downloads the whole archive.
 */
async function peekZipArchive(
  storage: StorageProvider,
  path: string,
  signal: AbortSignal | undefined,
): Promise<PeekArchiveResult> {
  const stat = await storage.statFile(path);
  const fileSize = stat.size;
  if (fileSize === 0) {
    throw new UnreadableArchiveError();
  }

  const tailLength = Math.min(fileSize, PEEK_TAIL_READ_BYTES);
  const tailStart = fileSize - tailLength;
  const tailDownload = await storage.download(path, {
    range: { start: tailStart, end: fileSize - 1 },
    ...withSignal(signal),
  });
  const tail = await readAllBytes(tailDownload.body);

  const location = locateZipCentralDirectory(tail, fileSize);
  if (location === null) {
    throw new UnreadableArchiveError();
  }
  if (location.size === 0) {
    return { format: "zip", entries: [], truncated: false };
  }
  if (
    location.size > PEEK_MAX_CENTRAL_DIRECTORY_BYTES ||
    location.offset + location.size > fileSize
  ) {
    throw new UnreadableArchiveError();
  }

  const cdDownload = await storage.download(path, {
    range: { start: location.offset, end: location.offset + location.size - 1 },
    ...withSignal(signal),
  });
  const cdBuffer = await readAllBytes(cdDownload.body);

  let parsed: PeekEntry[];
  try {
    parsed = parseZipCentralDirectoryEntries(cdBuffer);
  } catch (error) {
    if (error instanceof CorruptZipCentralDirectoryError) {
      throw new UnreadableArchiveError();
    }
    throw error;
  }

  const { entries, truncated } = boundPeekEntries(sortPeekEntries(parsed), PEEK_MAX_ENTRIES);
  return { format: "zip", entries, truncated };
}

/**
 * Reads a tar family archive's entries by streaming it through
 * `collectTarPeekEntries`, never writing anything to disk. `kind` is
 * always a tar-family `ArchiveKind` here (`peekArchive` sends `zip` and
 * `gz` down a different path), so `tarCompressionFor` always resolves.
 */
async function peekTarArchive(
  storage: StorageProvider,
  path: string,
  kind: "tar" | "tar.gz" | "tar.zst",
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<PeekArchiveResult> {
  const compression = tarCompressionFor(kind);
  if (compression === null) {
    throw new UnreadableArchiveError();
  }

  const download = await storage.download(path, withSignal(signal));

  let collected: { entries: PeekEntry[]; truncated: boolean };
  try {
    collected = await collectTarPeekEntries(download.body, compression, maxBytes, PEEK_MAX_ENTRIES);
  } catch {
    throw new UnreadableArchiveError();
  }

  return {
    format: kind,
    entries: sortPeekEntries(collected.entries),
    truncated: collected.truncated,
  };
}

/**
 * Reads an archive's entries without extracting it: `zip` via two Range
 * reads and a pure central-directory parse, the tar family (`tar`,
 * `tar.gz`, `tar.zst`) by streaming it and stopping once
 * `PEEK_MAX_ENTRIES` entries or `opts.maxBytes` of compressed input have
 * been read. Throws `UnsupportedPeekFormatError` for an extension this does
 * not read, `UnreadableArchiveError` for a recognized but corrupt archive,
 * and lets a `StorageError` from `opts.storage` propagate unchanged.
 */
export async function peekArchive(opts: PeekArchiveOptions): Promise<PeekArchiveResult> {
  const name = baseName(opts.path);
  const kind = detectArchiveKind(name);
  if (kind === null || kind === "gz") {
    throw new UnsupportedPeekFormatError(`not a recognized archive: ${name}`);
  }
  if (kind === "tar.zst" && !(opts.zstdSupported ?? isZstdSupported())) {
    throw new UnsupportedPeekFormatError("tar.zst unsupported on this server");
  }
  if (kind === "zip") {
    return peekZipArchive(opts.storage, opts.path, opts.signal);
  }
  return peekTarArchive(opts.storage, opts.path, kind, opts.maxBytes, opts.signal);
}
