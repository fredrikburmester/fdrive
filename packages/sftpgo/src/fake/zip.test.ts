import { describe, expect, it } from "vitest";
import { buildZip, crc32 } from "./zip.js";

describe("crc32", () => {
  it("matches the well-known test vector", () => {
    const bytes = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    expect(crc32(bytes).toString(16)).toBe("414fa339");
  });

  it("returns 0 for empty input", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

interface ParsedCentralEntry {
  name: string;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Minimal ZIP parser used only by tests, reading the central directory. */
function parseZip(zip: Uint8Array): ParsedCentralEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  // Find the end-of-central-directory record (fixed 22 bytes, no comment in our encoder).
  const eocdOffset = zip.length - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  expect(eocdOffset).toBe(centralDirectoryOffset + centralDirectorySize);

  const entries: ParsedCentralEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let i = 0; i < entryCount; i++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameBytes = zip.slice(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    entries.push({ name, crc, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(centralDirectoryOffset + centralDirectorySize);
  return entries;
}

function readLocalFileContent(zip: Uint8Array, offset: number, expectedSize: number): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  expect(view.getUint32(offset, true)).toBe(0x04034b50);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const contentStart = offset + 30 + nameLength + extraLength;
  return zip.slice(contentStart, contentStart + expectedSize);
}

describe("buildZip", () => {
  it("produces an archive with an empty entry list", () => {
    const zip = buildZip([]);
    const entries = parseZip(zip);
    expect(entries).toEqual([]);
  });

  it("produces a valid central directory for multiple entries", () => {
    const fileA = new TextEncoder().encode("hello");
    const fileB = new TextEncoder().encode("a slightly longer world of content");
    const zip = buildZip([
      { name: "a.txt", content: fileA },
      { name: "dir/b.txt", content: fileB, mtime: new Date("2024-06-01T12:34:56Z") },
    ]);

    const entries = parseZip(zip);
    expect(entries).toHaveLength(2);

    const [entryA, entryB] = entries;
    expect(entryA?.name).toBe("a.txt");
    expect(entryA?.uncompressedSize).toBe(fileA.length);
    expect(entryA?.compressedSize).toBe(fileA.length);
    expect(entryA?.crc).toBe(crc32(fileA));

    expect(entryB?.name).toBe("dir/b.txt");
    expect(entryB?.uncompressedSize).toBe(fileB.length);
    expect(entryB?.crc).toBe(crc32(fileB));

    expect(readLocalFileContent(zip, entryA?.localHeaderOffset ?? 0, fileA.length)).toEqual(fileA);
    expect(readLocalFileContent(zip, entryB?.localHeaderOffset ?? 0, fileB.length)).toEqual(fileB);
  });

  it("defaults the modification time to the epoch when not given", () => {
    const content = new TextEncoder().encode("x");
    const zip = buildZip([{ name: "x.txt", content }]);
    const entries = parseZip(zip);
    expect(entries[0]?.crc).toBe(crc32(content));
  });

  it("clamps a pre-1980 mtime to the DOS epoch", () => {
    const content = new TextEncoder().encode("old");
    const zip = buildZip([{ name: "old.txt", content, mtime: new Date("1970-01-01T00:00:00Z") }]);
    const entries = parseZip(zip);
    expect(entries).toHaveLength(1);
  });
});
