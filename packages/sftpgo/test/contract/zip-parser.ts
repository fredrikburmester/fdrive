/**
 * A tiny ZIP central-directory reader used only by the contract tests, so
 * they can assert on the entries of a zip returned by either the fake
 * server or the real SFTPGo container without pulling in a zip dependency.
 *
 * Unlike packages/sftpgo/src/fake/zip.ts (which writes zips), this only
 * reads the end-of-central-directory record and then walks the central
 * directory itself. That works regardless of the compression method used
 * for each entry's data, since the central directory carries the
 * uncompressed size and name for every entry without needing to touch the
 * (possibly deflated) file data at all.
 */

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
/** Fixed portion of the end-of-central-directory record, with no comment. */
const EOCD_RECORD_SIZE = 22;
/** Fixed portion of a central directory file header, before the variable-length fields. */
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;

export interface ZipEntryInfo {
  readonly name: string;
  readonly uncompressedSize: number;
}

/**
 * Finds the offset of the end-of-central-directory record by scanning
 * backward from the end of the buffer. Assumes the zip has no trailing
 * comment, which holds for every zip produced by this codebase's fake
 * encoder and by SFTPGo's streaming zip endpoints.
 */
function findEndOfCentralDirectory(view: DataView): number {
  for (let offset = view.byteLength - EOCD_RECORD_SIZE; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("parseZipCentralDirectory: end of central directory record not found");
}

/** Parses the central directory of a zip archive into a list of entry names and sizes. */
export function parseZipCentralDirectory(buffer: Uint8Array): ZipEntryInfo[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  const decoder = new TextDecoder();
  const entries: ZipEntryInfo[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index++) {
    const signature = view.getUint32(offset, true);
    if (signature !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(
        `parseZipCentralDirectory: expected central directory signature at offset ${offset}, got 0x${signature.toString(16)}`,
      );
    }
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + CENTRAL_DIRECTORY_HEADER_SIZE;
    const nameBytes = buffer.subarray(nameStart, nameStart + nameLength);
    entries.push({ name: decoder.decode(nameBytes), uncompressedSize });
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}
