import type { EntryKind, SftpgoEntry } from "./types.js";

/** Go's os.ModeDir bit (1 << 31). */
const DIR_BIT = 0x80000000;
/** Go's os.ModeSymlink bit (1 << 27). */
const SYMLINK_BIT = 0x08000000;
/** Go's os.ModeType mask: the set of bits that mark a non-regular file. */
const TYPE_MASK = 0x8f280000;

export interface RawSftpgoEntry {
  readonly name: string;
  readonly size?: number;
  readonly mode: number;
  readonly last_modified: string;
}

/**
 * Classifies a SFTPGo file mode into an EntryKind. Bitwise operators in
 * JavaScript convert their operands to 32-bit integers first, so this works
 * correctly even though `mode` may arrive as a value above 2^31 (which
 * JSON.parse represents as a positive double, not a negative int32) -- the
 * underlying bit pattern is preserved by the conversion.
 */
export function classifyKind(mode: number): EntryKind {
  if ((mode & DIR_BIT) !== 0) {
    return "dir";
  }
  if ((mode & SYMLINK_BIT) !== 0) {
    return "symlink";
  }
  if ((mode & TYPE_MASK) === 0) {
    return "file";
  }
  return "other";
}

/** Converts a raw SFTPGo directory-listing entry into a SftpgoEntry. */
export function toEntry(raw: RawSftpgoEntry): SftpgoEntry {
  return {
    name: raw.name,
    kind: classifyKind(raw.mode),
    size: raw.size ?? 0,
    modifiedAt: new Date(raw.last_modified),
    mode: raw.mode,
  };
}
