import { joinPath } from "@fdrive/core";
import { encryptName, type FolderKey } from "@fdrive/crypto";
import type { UploadItem } from "@/lib/upload/types";
import { encryptBlob } from "./content";

export interface EncryptedUploadOptions {
  /** The folder the files go to, as fdrive stores it. */
  readonly destination: string;
  readonly folder: FolderKey;
  /** The stored names of what is already there, by clear name: a folder there is reused. */
  readonly storedByName: ReadonlyMap<string, string>;
}

/**
 * Gives planned uploads into an encrypted folder their encrypted names and a
 * source that encrypts each file as it starts. Every folder in a batch gets
 * one encrypted name, so files that share a folder land in the same one.
 * Throws `NameTooLongError` for a name an encrypted folder cannot hold.
 */
export async function prepareEncryptedUploads(
  items: readonly UploadItem[],
  options: EncryptedUploadOptions,
): Promise<UploadItem[]> {
  const stored = new Map<string, string>();
  async function storedSegment(clearPath: string, name: string, top: boolean): Promise<string> {
    const known = stored.get(clearPath) ?? (top ? options.storedByName.get(name) : undefined);
    if (known !== undefined) return known;
    const made = await encryptName(name, options.folder.nameKey, options.folder.id);
    stored.set(clearPath, made);
    return made;
  }
  const prepared: UploadItem[] = [];
  // One at a time: two files in a new folder must not each name it.
  for (const item of items) {
    const segments = item.relativePath.split("/");
    const storedSegments: string[] = [];
    for (const [index, name] of segments.entries()) {
      const clearPath = segments.slice(0, index + 1).join("/");
      storedSegments.push(await storedSegment(clearPath, name, index === 0));
    }
    const { recipient } = options.folder;
    prepared.push({
      ...item,
      targetPath: joinPath(options.destination, ...storedSegments),
      source: () => encryptBlob(item.file, recipient),
    });
  }
  return prepared;
}
