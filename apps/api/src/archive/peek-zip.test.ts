import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { buildRawZip } from "../../test/fixtures/build-zip.js";
import {
  CorruptZipCentralDirectoryError,
  locateZipCentralDirectory,
  parseZipCentralDirectoryEntries,
} from "./peek-zip.js";

/** Drains a yazl `ZipFile`'s output stream into one `Buffer`, calling
 * `.end()` (with `forceZip64Format` when asked) once every entry is added. */
async function buildZipBuffer(
  build: (zipfile: ZipFile) => void,
  forceZip64Format = false,
): Promise<Buffer> {
  const zipfile = new ZipFile();
  build(zipfile);
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on("end", resolve);
    zipfile.outputStream.on("error", reject);
  });
  zipfile.end({ forceZip64Format, comment: "" });
  await done;
  return Buffer.concat(chunks);
}

/** The last `min(65536, zip.length)` bytes: the tail the route itself reads. */
function tailOf(zip: Buffer): Buffer {
  return zip.subarray(Math.max(0, zip.length - 65536));
}

/** Locates and parses every entry of `zip`, exactly as the route would from
 * its two Range reads. */
function readZip(zip: Buffer) {
  const location = locateZipCentralDirectory(tailOf(zip), zip.length);
  if (location === null) {
    throw new Error("central directory not found in test fixture");
  }
  const centralDirectory = zip.subarray(location.offset, location.offset + location.size);
  return { location, entries: parseZipCentralDirectoryEntries(centralDirectory) };
}

describe("locateZipCentralDirectory + parseZipCentralDirectoryEntries: real yazl fixtures", () => {
  it("reads a file entry and a directory entry, with a UTF-8 name", async () => {
    const mtime = new Date(2024, 0, 15, 10, 30, 0);
    const zip = await buildZipBuffer((zipfile) => {
      zipfile.addBuffer(Buffer.from("hello world"), "日本語/ファイル.txt", { mtime });
      zipfile.addEmptyDirectory("empty-dir", { mtime });
    });

    const { entries } = readZip(zip);
    expect(entries).toHaveLength(2);

    const file = entries.find((e) => e.kind === "file");
    expect(file).toEqual({
      path: "日本語/ファイル.txt",
      kind: "file",
      size: 11,
      modifiedAt: mtime,
    });

    const dir = entries.find((e) => e.kind === "dir");
    expect(dir).toEqual({
      path: "empty-dir",
      kind: "dir",
      size: 0,
      modifiedAt: mtime,
    });
  });

  it("reads the real (64-bit) size from a ZIP64 entry and locates its ZIP64 end-of-central-directory record", async () => {
    const mtime = new Date(2025, 5, 1, 0, 0, 0);
    const content = Buffer.from("zip64 content");
    const zip = await buildZipBuffer((zipfile) => {
      zipfile.addBuffer(content, "big.bin", { mtime, forceZip64Format: true });
    }, true);

    const { entries } = readZip(zip);
    expect(entries).toEqual([
      { path: "big.bin", kind: "file", size: content.length, modifiedAt: mtime },
    ]);
  });

  it("returns an empty entry list for an archive with no entries", async () => {
    const zip = await buildZipBuffer(() => {});
    const { entries } = readZip(zip);
    expect(entries).toEqual([]);
  });
});

describe("locateZipCentralDirectory + parseZipCentralDirectoryEntries: a whole zip-slip archive", () => {
  it("locates and parses a real archive containing a '..' entry end to end, reporting it as kind file", () => {
    const zip = Buffer.from(
      buildRawZip([
        { name: "ok.txt", content: Buffer.from("fine") },
        { name: "../evil.txt", content: Buffer.from("slip") },
      ]),
    );

    const { entries } = readZip(zip);
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: "ok.txt", kind: "file", size: 4, modifiedAt: expect.any(Date) },
        { path: "../evil.txt", kind: "file", size: 4, modifiedAt: expect.any(Date) },
      ]),
    );
  });
});

describe("locateZipCentralDirectory: truncated and corrupt input", () => {
  it("returns null for a buffer with no EOCD signature", () => {
    expect(locateZipCentralDirectory(Buffer.alloc(100), 100)).toBeNull();
  });

  it("returns null for a tail too short to hold the EOCD's fixed fields", async () => {
    const zip = await buildZipBuffer((zipfile) => zipfile.addBuffer(Buffer.from("x"), "a.txt"));
    const truncated = zip.subarray(zip.length - 5);
    expect(locateZipCentralDirectory(truncated, zip.length)).toBeNull();
  });

  it("returns null when the EOCD claims ZIP64 but there is no room for a locator before it", () => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 10); // total entries: ZIP64 sentinel
    expect(locateZipCentralDirectory(eocd, 22)).toBeNull();
  });

  it("returns null when the ZIP64 locator's signature does not match", () => {
    const buffer = Buffer.alloc(42);
    // 20 bytes of not-a-locator, then a 22-byte EOCD claiming ZIP64.
    buffer.writeUInt32LE(0x06054b50, 20);
    buffer.writeUInt16LE(0xffff, 30);
    expect(locateZipCentralDirectory(buffer, 42)).toBeNull();
  });

  it("returns null when the located ZIP64 EOCD record falls outside the tail", () => {
    const buffer = Buffer.alloc(42);
    // A locator claiming the ZIP64 record sits far before this tail window.
    buffer.writeUInt32LE(0x07064b50, 0);
    buffer.writeBigUInt64LE(0n, 8); // absolute offset 0, but tailStart is far from 0
    buffer.writeUInt32LE(0x06054b50, 20);
    buffer.writeUInt16LE(0xffff, 30);
    // fileSize much larger than the tail, so tailStart (fileSize - tail.length) is nonzero.
    expect(locateZipCentralDirectory(buffer, 1_000_000)).toBeNull();
  });

  it("returns null when the ZIP64 EOCD record's own signature does not match", () => {
    const buffer = Buffer.alloc(20 + 56 + 22);
    // ZIP64 record area (56 bytes) at the very start, left as zeroes (wrong signature).
    buffer.writeUInt32LE(0x07064b50, 56); // locator right after the (bogus) record
    buffer.writeBigUInt64LE(0n, 56 + 8); // points at offset 0, inside this buffer
    buffer.writeUInt32LE(0x06054b50, 56 + 20); // EOCD right after the locator
    buffer.writeUInt16LE(0xffff, 56 + 20 + 10);
    expect(locateZipCentralDirectory(buffer, buffer.length)).toBeNull();
  });

  it("throws for a central directory buffer whose first record has a bad signature", () => {
    expect(() => parseZipCentralDirectoryEntries(Buffer.alloc(46))).toThrow(
      CorruptZipCentralDirectoryError,
    );
  });

  it("throws for a central directory record truncated mid-header", () => {
    expect(() => parseZipCentralDirectoryEntries(Buffer.alloc(10))).toThrow(
      CorruptZipCentralDirectoryError,
    );
  });

  it("throws when a record's declared name/extra/comment length runs past the buffer", () => {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(100, 28); // name length far longer than what follows
    expect(() => parseZipCentralDirectoryEntries(record)).toThrow(CorruptZipCentralDirectoryError);
  });
});

/**
 * Builds one raw central directory file header record by hand (bypassing
 * yazl entirely, since it validates entry names and refuses to write one
 * containing ".." or an absolute path): fixed 46-byte header plus a raw
 * name, matching the exact layout yazl itself writes.
 */
function buildRawCentralDirectoryRecord(opts: {
  name: string;
  isUtf8?: boolean;
  uncompressedSize?: number;
  date?: number;
  time?: number;
  extra?: Buffer;
}): Buffer {
  const nameBuffer = Buffer.from(opts.name, opts.isUtf8 === false ? "latin1" : "utf8");
  const extra = opts.extra ?? Buffer.alloc(0);
  const record = Buffer.alloc(46 + nameBuffer.length + extra.length);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(opts.isUtf8 === false ? 0 : 0x0800, 8); // general purpose bit flag
  record.writeUInt16LE(opts.time ?? 0, 12);
  record.writeUInt16LE(opts.date ?? ((1980 - 1980) << 9) | (1 << 5) | 1, 14);
  record.writeUInt32LE(opts.uncompressedSize ?? 0, 24);
  record.writeUInt16LE(nameBuffer.length, 28);
  record.writeUInt16LE(extra.length, 30);
  nameBuffer.copy(record, 46);
  extra.copy(record, 46 + nameBuffer.length);
  return record;
}

describe("parseZipCentralDirectoryEntries: names never used as real filesystem paths", () => {
  it("reports a name containing '..' as-is, forced to kind file", () => {
    const record = buildRawCentralDirectoryRecord({ name: "../evil.txt", uncompressedSize: 3 });
    expect(parseZipCentralDirectoryEntries(record)).toEqual([
      { path: "../evil.txt", kind: "file", size: 3, modifiedAt: expect.any(Date) },
    ]);
  });

  it("reports an absolute name as-is, forced to kind file even with a trailing slash", () => {
    const record = buildRawCentralDirectoryRecord({ name: "/etc/", uncompressedSize: 0 });
    expect(parseZipCentralDirectoryEntries(record)).toEqual([
      { path: "/etc", kind: "file", size: 0, modifiedAt: expect.any(Date) },
    ]);
  });

  it("decodes a name as latin1 when the UTF-8 flag is not set", () => {
    const record = buildRawCentralDirectoryRecord({ name: "plain.txt", isUtf8: false });
    expect(parseZipCentralDirectoryEntries(record)[0]?.path).toBe("plain.txt");
  });

  it("clamps an all-zero DOS date to a valid Date instead of producing an invalid one", () => {
    const record = buildRawCentralDirectoryRecord({ name: "a.txt", date: 0, time: 0 });
    const modifiedAt = parseZipCentralDirectoryEntries(record)[0]?.modifiedAt;
    expect(modifiedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(modifiedAt?.getTime())).toBe(false);
  });
});

describe("parseZipCentralDirectoryEntries: ZIP64 extra field fallbacks", () => {
  function zip64Extra(size?: number, uncompressedSize?: bigint): Buffer {
    const extra = Buffer.alloc(4 + (size ?? 8));
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(size ?? 8, 2);
    if (uncompressedSize !== undefined && extra.length >= 12) {
      extra.writeBigUInt64LE(uncompressedSize, 4);
    }
    return extra;
  }

  it("falls back to the 32-bit sentinel when no ZIP64 extra field is present", () => {
    const record = buildRawCentralDirectoryRecord({
      name: "huge.bin",
      uncompressedSize: 0xffffffff,
    });
    expect(parseZipCentralDirectoryEntries(record)[0]?.size).toBe(0xffffffff);
  });

  it("falls back to the 32-bit sentinel when the ZIP64 block is too short to hold a size", () => {
    const record = buildRawCentralDirectoryRecord({
      name: "huge.bin",
      uncompressedSize: 0xffffffff,
      extra: zip64Extra(4),
    });
    expect(parseZipCentralDirectoryEntries(record)[0]?.size).toBe(0xffffffff);
  });

  it("skips an unrelated extra block before finding the ZIP64 block", () => {
    const unrelated = Buffer.alloc(8);
    unrelated.writeUInt16LE(0x5455, 0);
    unrelated.writeUInt16LE(4, 2);
    const combined = Buffer.concat([unrelated, zip64Extra(8, 5_000_000_000n)]);
    const record = buildRawCentralDirectoryRecord({
      name: "huge.bin",
      uncompressedSize: 0xffffffff,
      extra: combined,
    });
    expect(parseZipCentralDirectoryEntries(record)[0]?.size).toBe(5_000_000_000);
  });
});
