import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unzip } from "./unzip.ts";

/** A zip of one deflated file, as the files folder writes text files. */
function deflatedZip(name: string, text: string): Uint8Array {
  const content = Buffer.from(text);
  const data = deflateRawSync(content);
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

describe("unzip", () => {
  it("inflates a deflated file", () => {
    expect(unzip(deflatedZip("a.txt", "deflate me, deflate me"))).toEqual({
      "a.txt": "deflate me, deflate me",
    });
  });
});
