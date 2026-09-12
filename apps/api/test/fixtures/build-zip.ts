/**
 * A minimal ZIP encoder (stored method only, no validation of entry names)
 * for building test fixtures, including zip-slip fixtures that a real
 * zip-writing library (yazl included) refuses to produce because it
 * validates entry names itself. Not exercised by its own unit tests: this
 * is a test fixture, excluded from coverage by living under `test/` rather
 * than `src/`.
 */

export interface RawZipEntry {
  readonly name: string;
  readonly content: Uint8Array;
  readonly nameBytes?: Uint8Array;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION = 20;

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    result.set(part, position);
    position += part.length;
  }
  return result;
}

/** Builds a raw ZIP archive (stored method, no compression, no name validation) from `entries`. */
export function buildRawZip(entries: readonly RawZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = entry.nameBytes ?? encoder.encode(entry.name);
    const crc = crc32(entry.content);
    const size = entry.content.length;

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
    localHeader.setUint16(4, VERSION, true);
    localHeader.setUint16(6, entry.nameBytes === undefined ? 0x800 : 0, true);
    localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, 0, true);
    localHeader.setUint16(12, 0, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, size, true);
    localHeader.setUint32(22, size, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);
    const localHeaderBytes = new Uint8Array(localHeader.buffer);
    localParts.push(localHeaderBytes, nameBytes, entry.content);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
    centralHeader.setUint16(4, VERSION, true);
    centralHeader.setUint16(6, VERSION, true);
    centralHeader.setUint16(8, entry.nameBytes === undefined ? 0x800 : 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, 0, true);
    centralHeader.setUint16(14, 0, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, size, true);
    centralHeader.setUint32(24, size, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);
    const centralHeaderBytes = new Uint8Array(centralHeader.buffer);
    centralParts.push(centralHeaderBytes, nameBytes);

    offset += localHeaderBytes.length + nameBytes.length + entry.content.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralDirectorySize, true);
  end.setUint32(16, centralDirectoryOffset, true);
  end.setUint16(20, 0, true);

  return concatUint8Arrays([...localParts, ...centralParts, new Uint8Array(end.buffer)]);
}
