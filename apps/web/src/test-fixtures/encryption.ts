import type { EncryptedFolderInfo, FsEntry } from "@fdrive/contracts";
import { createFolder, encryptName, type FolderKey, newKeyPair } from "@fdrive/crypto";

/** A new account and an encrypted folder at `path` made for it, as the browser makes them. */
export async function encryptedFolder(
  path = "/Private",
): Promise<{ identity: string; info: EncryptedFolderInfo; folder: FolderKey }> {
  const account = await newKeyPair();
  const { marker, folder } = await createFolder(account.identity);
  return { identity: account.identity, info: { path, marker }, folder };
}

/** A listing entry as fdrive returns it, named `name` on disk. */
export function stored(
  parent: string,
  name: string,
  kind: "file" | "dir" = "file",
  size = 0,
): FsEntry {
  return {
    name,
    path: parent === "/" ? `/${name}` : `${parent}/${name}`,
    kind,
    size,
    modifiedAt: new Date(0).toISOString(),
    ext: "",
    mime: null,
  };
}

/** A listing entry inside an encrypted folder, its clear `name` encrypted with the folder's key. */
export async function encryptedEntry(
  parent: string,
  name: string,
  folder: FolderKey,
  kind: "file" | "dir" = "file",
  size = 0,
): Promise<FsEntry> {
  return stored(parent, await encryptName(name, folder.nameKey, folder.id), kind, size);
}

export async function bytesOf(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}
