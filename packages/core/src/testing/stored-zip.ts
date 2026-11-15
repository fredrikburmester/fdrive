/** One entry of a zip: a file and its bytes, or a folder without `content`. */
export interface StoredZipEntry {
  /** Its path in the archive, without a trailing slash. */
  readonly name: string;
  readonly content?: Uint8Array;
  readonly modifiedAt: Date;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** `at` as MS-DOS time and date, which start in 1980. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(at.getFullYear(), 1980) - 1980;
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: (year << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/** UTF-8 names (general purpose bit 11). */
const UTF8 = 0x0800;

/**
 * A zip of `entries` that stores every file as it is, uncompressed: the
 * memory storage's archive, which any zip reader opens.
 */
export function storedZip(entries: readonly StoredZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const folder = entry.content === undefined;
    const name = encoder.encode(folder ? `${entry.name}/` : entry.name);
    const data = entry.content ?? new Uint8Array();
    const crc = crc32(data);
    const { time, date } = dosTime(entry.modifiedAt);

    const local = new Uint8Array(30 + name.length + data.length);
    const head = new DataView(local.buffer);
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, UTF8, true);
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, UTF8, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, name.length, true);
    // The MS-DOS directory attribute marks a folder.
    record.setUint32(38, folder ? 0x10 : 0, true);
    record.setUint32(42, offset, true);
    central.set(name, 46);

    parts.push(local);
    directory.push(central);
    offset += local.length;
  }
  const size = directory.reduce((total, record) => total + record.length, 0);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, entries.length, true);
  tail.setUint16(10, entries.length, true);
  tail.setUint32(12, size, true);
  tail.setUint32(16, offset, true);

  const zip = new Uint8Array(offset + size + end.length);
  let at = 0;
  for (const part of [...parts, ...directory, end]) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}
