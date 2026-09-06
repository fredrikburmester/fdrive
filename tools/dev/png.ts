/**
 * A minimal PNG encoder, just enough to produce a small valid RGB image for
 * the dev seed data. Not a general-purpose encoder: fixed to 8-bit RGB,
 * no interlacing, and one uncompressed-per-row raw filter (type 0, "none").
 */
import { deflateSync, crc32 as zlibCrc32 } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BIT_DEPTH_8 = 8;
const COLOR_TYPE_RGB = 2;
const COMPRESSION_METHOD_DEFLATE = 0;
const FILTER_METHOD_ADAPTIVE = 0;
const INTERLACE_METHOD_NONE = 0;
const FILTER_TYPE_NONE = 0;
const BYTES_PER_PIXEL_RGB = 3;

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function buildChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuffer, data]);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

/** CRC-32 (IEEE 802.3), the checksum PNG chunks require. */
function crc32(data: Buffer): number {
  return zlibCrc32(data) >>> 0;
}

function buildIhdr(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(BIT_DEPTH_8, 8);
  ihdr.writeUInt8(COLOR_TYPE_RGB, 9);
  ihdr.writeUInt8(COMPRESSION_METHOD_DEFLATE, 10);
  ihdr.writeUInt8(FILTER_METHOD_ADAPTIVE, 11);
  ihdr.writeUInt8(INTERLACE_METHOD_NONE, 12);
  return ihdr;
}

function buildRawScanlines(
  width: number,
  height: number,
  pixel: (x: number, y: number) => RgbColor,
): Buffer {
  const stride = 1 + width * BYTES_PER_PIXEL_RGB;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw.writeUInt8(FILTER_TYPE_NONE, rowStart);
    for (let x = 0; x < width; x += 1) {
      const color = pixel(x, y);
      const offset = rowStart + 1 + x * BYTES_PER_PIXEL_RGB;
      raw.writeUInt8(color.r, offset);
      raw.writeUInt8(color.g, offset + 1);
      raw.writeUInt8(color.b, offset + 2);
    }
  }

  return raw;
}

/**
 * Encodes a `width` by `height` 8-bit RGB PNG, calling `pixel(x, y)` for
 * every pixel to determine its colour. Pure: the same arguments always
 * produce the same bytes.
 */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => RgbColor,
): Buffer {
  const raw = buildRawScanlines(width, height, pixel);
  const compressed = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk("IHDR", buildIhdr(width, height)),
    buildChunk("IDAT", compressed),
    buildChunk("IEND", Buffer.alloc(0)),
  ]);
}
