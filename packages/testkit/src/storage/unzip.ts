import { crc32, inflateRawSync } from "node:zlib";
import { expect } from "vitest";

/**
 * What a zip reader finds in `zip`, by name: each file's text, inflated when
 * deflated and checked against its CRC, and "" for each folder, whose name
 * ends in "/". Read through the central directory, as readers do.
 */
export function unzip(zip: Uint8Array): Record<string, string> {
  const bytes = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end), "end of central directory").toBe(0x06054b50);
  const entries: Record<string, string> = {};
  let at = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index += 1) {
    expect(bytes.readUInt32LE(at), "central directory record").toBe(0x02014b50);
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const local = bytes.readUInt32LE(at + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const stored = bytes.subarray(start, start + size);
    const content = method === 8 ? inflateRawSync(stored) : stored;
    expect(crc32(content), `${name}'s CRC`).toBe(bytes.readUInt32LE(at + 16));
    entries[name] = content.toString("utf8");
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return entries;
}
