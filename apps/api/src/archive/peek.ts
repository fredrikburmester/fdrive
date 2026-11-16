import { baseName, detectArchiveKind, type OpenFile, type StorageProvider } from "@fdrive/core";
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

/** What `peekArchive` needs of a storage: any `StorageProvider` has it. */
export type PeekStoragePort = Pick<StorageProvider, "open">;

export interface PeekArchiveOptions {
  readonly storage: PeekStoragePort;
  readonly path: string;
  /** Cap on bytes read for the tar family's streaming scan. Unused for
   * zip, whose two reads are already bounded by its own metadata. */
  readonly maxBytes: number;
  /** Stops the tar family's scan once the reader has gone. */
  readonly signal?: AbortSignal;
  /** Overrides whether `tar.zst` is supported, for tests. Defaults to `isZstdSupported()`. */
  readonly zstdSupported?: boolean;
}

/** Exactly `length` bytes at `position`, or the archive is not what it claims. */
async function readExactly(file: OpenFile, position: number, length: number): Promise<Uint8Array> {
  const bytes = await file.read(position, length);
  if (bytes.length !== length) throw new UnreadableArchiveError();
  return bytes;
}

/**
 * Reads a zip's entries with exactly two reads: the last
 * `PEEK_TAIL_READ_BYTES` (or the whole file, if smaller) to find the
 * end-of-central-directory record, then exactly the central directory it
 * points at. Never reads the whole archive.
 */
async function peekZipArchive(file: OpenFile): Promise<PeekArchiveResult> {
  const fileSize = file.size;
  if (fileSize === 0) {
    throw new UnreadableArchiveError();
  }

  const tailLength = Math.min(fileSize, PEEK_TAIL_READ_BYTES);
  const tail = Buffer.from(await readExactly(file, fileSize - tailLength, tailLength));

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

  const cdBuffer = Buffer.from(await readExactly(file, location.offset, location.size));

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
  file: OpenFile,
  kind: "tar" | "tar.gz" | "tar.zst",
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<PeekArchiveResult> {
  const compression = tarCompressionFor(kind);
  if (compression === null) {
    throw new UnreadableArchiveError();
  }

  let collected: { entries: PeekEntry[]; truncated: boolean };
  try {
    collected = await collectTarPeekEntries(
      file.stream(),
      compression,
      maxBytes,
      PEEK_MAX_ENTRIES,
      signal,
    );
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
 * Reads an archive's entries without extracting it: `zip` via two reads
 * by position and a pure central-directory parse, the tar family (`tar`,
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
  const file = await opts.storage.open(opts.path);
  try {
    return kind === "zip"
      ? await peekZipArchive(file)
      : await peekTarArchive(file, kind, opts.maxBytes, opts.signal);
  } finally {
    await file.close();
  }
}
