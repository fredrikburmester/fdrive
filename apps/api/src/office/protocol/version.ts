import { createHash } from "node:crypto";
import type { ContentStamp, StorageProvider } from "@fdrive/core";

/**
 * A WOPI file version from a file's stamp. Any write moves the change time and
 * a publish replaces the inode, so the version changes whenever the bytes can
 * have, including a same-size replacement that keeps its modification time.
 */
export function deriveFileVersion(stamp: ContentStamp): string {
  return createHash("sha256")
    .update(`${stamp.size}:${stamp.mtimeNs}:${stamp.ino}:${stamp.ctimeNs}`)
    .digest("hex")
    .slice(0, 32);
}

/** The document at `path` as CheckFileInfo and PutFile describe it, read without reading its bytes. */
export async function documentVersion(
  storage: StorageProvider,
  path: string,
): Promise<{ version: string; size: number; modifiedAt: Date }> {
  if (storage.contentStamp === undefined)
    throw new Error("Office needs storage that stamps its files");
  const stamp = await storage.contentStamp(path);
  return {
    version: deriveFileVersion(stamp),
    size: stamp.size,
    modifiedAt: new Date(Number(stamp.mtimeNs / 1_000_000n)),
  };
}
