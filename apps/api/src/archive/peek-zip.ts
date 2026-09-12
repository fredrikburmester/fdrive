import { getFileNameLowLevel, parseExtraFields } from "yauzl";
import { buildPeekEntry, type PeekEntry } from "./peek-entry.js";

/**
 * A zip's central directory, located from its end-of-central-directory
 * record: where it starts and how many bytes it spans. `size` and `offset`
 * are the only fields the route needs (to issue its second Range read and
 * to know how many bytes to expect back).
 */
export interface ZipCentralDirectoryLocation {
  readonly offset: number;
  readonly size: number;
}

/** Thrown by `parseZipCentralDirectoryEntries` when the given bytes do not
 * decode as a well-formed sequence of central directory file headers. */
export class CorruptZipCentralDirectoryError extends Error {
  constructor() {
    super("corrupt zip central directory");
    this.name = "CorruptZipCentralDirectoryError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_FIXED_SIZE = 56;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const CENTRAL_DIRECTORY_FIXED_SIZE = 46;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const SENTINEL_16 = 0xffff;
const SENTINEL_32 = 0xffffffff;

/** Reads an 8-byte little-endian unsigned integer as a JS `number`. Zip
 * files fdrive itself ever needs to peek at never approach 2^53 bytes. */
function readUInt64LE(buffer: Buffer, offset: number): number {
  return Number(buffer.readBigUInt64LE(offset));
}

/**
 * Finds the end-of-central-directory record's start index within `tail`,
 * scanning from the end (the record's comment can itself coincidentally
 * contain the signature bytes, so the rightmost, i.e. last, match is the
 * real one). Returns `null` when no signature is found.
 */
function findEocdSignature(tail: Buffer): number | null {
  for (let i = tail.length - EOCD_FIXED_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  return null;
}

/**
 * Locates the central directory from `tail` (the last `tail.length` bytes
 * of a `fileSize`-byte zip file, normally the archive route's own 64 KiB
 * read). Reads the plain end-of-central-directory record, then, when any
 * of its three fields read the ZIP64 sentinel (0xffff/0xffffffff), the
 * ZIP64 locator and record that must sit immediately before it. Returns
 * `null` when no EOCD signature is found, the record itself is truncated,
 * or a ZIP64 record is indicated but does not fall entirely inside `tail`:
 * this function never issues a second read to fetch it, matching the
 * route's fixed two-Range-read budget.
 */
export function locateZipCentralDirectory(
  tail: Buffer,
  fileSize: number,
): ZipCentralDirectoryLocation | null {
  const tailStart = fileSize - tail.length;
  const eocdIndex = findEocdSignature(tail);
  if (eocdIndex === null || eocdIndex + EOCD_FIXED_SIZE > tail.length) {
    return null;
  }

  const diskEntryCount = tail.readUInt16LE(eocdIndex + 10);
  let size = tail.readUInt32LE(eocdIndex + 12);
  let offset = tail.readUInt32LE(eocdIndex + 16);

  const needsZip64 =
    diskEntryCount === SENTINEL_16 || size === SENTINEL_32 || offset === SENTINEL_32;
  if (!needsZip64) {
    return { offset, size };
  }

  const locatorIndex = eocdIndex - ZIP64_LOCATOR_SIZE;
  if (locatorIndex < 0 || tail.readUInt32LE(locatorIndex) !== ZIP64_LOCATOR_SIGNATURE) {
    return null;
  }

  const zip64EocdOffset = readUInt64LE(tail, locatorIndex + 8);
  const zip64Index = zip64EocdOffset - tailStart;
  if (
    zip64Index < 0 ||
    zip64Index + ZIP64_EOCD_FIXED_SIZE > tail.length ||
    tail.readUInt32LE(zip64Index) !== ZIP64_EOCD_SIGNATURE
  ) {
    return null;
  }

  size = readUInt64LE(tail, zip64Index + 40);
  offset = readUInt64LE(tail, zip64Index + 48);
  return { offset, size };
}

/**
 * Converts a MS-DOS date/time pair (as stored in a zip's central directory)
 * to a `Date`, in the local timezone (the format itself carries no zone).
 * Clamps an all-zero (never actually set) month or day to 1 rather than
 * producing an invalid `Date`.
 */
function dosDateTimeToDate(date: number, time: number): Date {
  const day = Math.max(date & 0x1f, 1);
  const month = Math.max((date >> 5) & 0xf, 1);
  const year = ((date >> 9) & 0x7f) + 1980;
  const seconds = (time & 0x1f) * 2;
  const minutes = (time >> 5) & 0x3f;
  const hours = (time >> 11) & 0x1f;
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

/**
 * Reads the real (64-bit) uncompressed size from a central directory
 * entry's extra field data, when its fixed-size field read the ZIP64
 * sentinel. The extra field is a sequence of `{ id: u16; size: u16; data }`
 * blocks (zip's own writers, including a plain-timestamp block, commonly
 * emit more than one); this scans past every block that is not the ZIP64
 * extended information block (id `0x0001`). Falls back to `fallback`
 * (0xffffffff) when no such block is found, or it is too short to hold the
 * size, so a malformed extra field never throws.
 */
function readZip64UncompressedSize(extra: Buffer, fallback: number): number {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    if (id === ZIP64_EXTRA_FIELD_ID && size >= 8 && pos + 4 + 8 <= extra.length) {
      return readUInt64LE(extra, pos + 4);
    }
    pos += 4 + size;
  }
  return fallback;
}

/**
 * Parses every central directory file header in `buffer` (exactly the
 * bytes the route's second Range read fetched, i.e. no leading or trailing
 * bytes outside the central directory itself) into `PeekEntry` values:
 * decodes each name per its UTF-8 general-purpose flag, reads its real
 * size from the ZIP64 extra field when the fixed field overflowed, and
 * reports a name ending in `/` as a directory (see `buildPeekEntry` for
 * how an unsafe name overrides that). Throws `CorruptZipCentralDirectoryError`
 * when a record's signature does not match or its declared name/extra/comment
 * lengths run past the end of `buffer`.
 */
export function parseZipCentralDirectoryEntries(buffer: Buffer): PeekEntry[] {
  const entries: PeekEntry[] = [];
  let pos = 0;

  while (pos < buffer.length) {
    if (
      pos + CENTRAL_DIRECTORY_FIXED_SIZE > buffer.length ||
      buffer.readUInt32LE(pos) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new CorruptZipCentralDirectoryError();
    }

    const flags = buffer.readUInt16LE(pos + 8);
    const time = buffer.readUInt16LE(pos + 12);
    const date = buffer.readUInt16LE(pos + 14);
    const uncompressedSize32 = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);

    const nameStart = pos + CENTRAL_DIRECTORY_FIXED_SIZE;
    const nameEnd = nameStart + nameLength;
    const extraEnd = nameEnd + extraLength;
    const recordEnd = extraEnd + commentLength;
    if (recordEnd > buffer.length) {
      throw new CorruptZipCentralDirectoryError();
    }

    const extra = buffer.subarray(nameEnd, extraEnd);
    const name = getFileNameLowLevel(
      flags,
      buffer.subarray(nameStart, nameEnd),
      parseExtraFields(extra),
      true,
    );
    const uncompressedSize =
      uncompressedSize32 === SENTINEL_32
        ? readZip64UncompressedSize(extra, uncompressedSize32)
        : uncompressedSize32;

    entries.push(
      buildPeekEntry(name, name.endsWith("/"), uncompressedSize, dosDateTimeToDate(date, time)),
    );
    pos = recordEnd;
  }

  return entries;
}
