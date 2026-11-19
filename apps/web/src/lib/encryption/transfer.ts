import type { ApiClient, FsEntry } from "@fdrive/contracts";
import { joinPath } from "@fdrive/core";
import { decryptName, encryptName, type FolderKey } from "@fdrive/crypto";
import { latestTrashIds } from "@/lib/files/undo";
import type { UploadItem } from "@/lib/upload/types";
import { decryptResponse, encryptBlob, readBody } from "./content";
import { UNREADABLE_NAME } from "./listing";

/** Which side of an encrypted folder's edge something is on: its folder's key, or none. */
export type Side = FolderKey | null;

export interface TransferRequest {
  /** What moves or copies, as the listing shows it. */
  readonly sources: readonly FsEntry[];
  readonly from: Side;
  /** The folder it goes into, as fdrive stores it. */
  readonly target: string;
  readonly to: Side;
  /** Delete each original for good once its copy is stored. */
  readonly move: boolean;
}

export type TransferApi = Pick<
  ApiClient,
  "list" | "mkdir" | "downloadUrl" | "remove" | "trashList" | "trashPurge"
>;

export interface TransferDeps {
  readonly api: TransferApi;
  readonly fetch: typeof fetch;
  readonly id: () => string;
}

/** Whether a move or copy from one side to another must go through the browser. */
export function crossesEdge(from: Side, to: Side): boolean {
  return (from?.id ?? null) !== (to?.id ?? null);
}

async function clearName(stored: string, side: Side): Promise<string> {
  if (side === null) return stored;
  const name = await decryptName(stored, side.nameKey, side.id);
  if (name === null) throw new Error(`${UNREADABLE_NAME} cannot be moved out of its folder.`);
  return name;
}

async function storedName(name: string, side: Side): Promise<string> {
  return side === null ? name : encryptName(name, side.nameKey, side.id);
}

/**
 * Deletes something for good: into Trash, then out of it, so a file that
 * moved into an encrypted folder leaves no clear copy behind.
 */
export async function deleteForGood(api: TransferApi, entry: Pick<FsEntry, "path" | "kind">) {
  await api.remove([{ path: entry.path, kind: entry.kind === "dir" ? "dir" : "file" }]);
  const trash = await api.trashList();
  const ids = latestTrashIds(trash.entries, [entry.path]);
  if (ids.length > 0) await api.trashPurge({ ids });
}

/**
 * Plans moving or copying across an encrypted folder's edge: folders are made
 * first, with their names re-encrypted or decrypted, then every file becomes
 * an upload whose source downloads it and encrypts or decrypts it in the
 * browser. A moved file's original is deleted for good once its copy is
 * stored, and a moved folder once everything in it has gone.
 */
export async function planTransfer(
  request: TransferRequest,
  deps: TransferDeps,
): Promise<UploadItem[]> {
  const { api } = deps;
  const items: UploadItem[] = [];
  const folders: FsEntry[] = [];

  function upload(source: FsEntry, targetPath: string, relativePath: string) {
    const fileName = relativePath.split("/").at(-1) ?? relativePath;
    items.push({
      id: deps.id(),
      file: new File([], fileName),
      targetPath,
      relativePath,
      size: source.size,
      status: "queued",
      progress: 0,
      attempts: 0,
      source: async () => {
        const response = await deps.fetch(api.downloadUrl(source.path), {
          credentials: "same-origin",
        });
        const plain =
          request.from === null
            ? await new Response(await readBody(response)).blob()
            : await decryptResponse(response, request.from.identity);
        return request.to === null ? plain : encryptBlob(plain, request.to.recipient);
      },
      ...(request.move
        ? {
            after: () => deleteForGood(api, source),
          }
        : {}),
    });
  }

  async function walk(source: FsEntry, targetDir: string, relativeDir: string): Promise<number> {
    // An encrypted folder inside what moves would arrive without its marker, and with it the
    // only key to its files. Nothing is queued or deleted when this throws.
    if (source.encrypted === true) {
      throw new Error("An encrypted folder cannot go inside another, or out of its own.");
    }
    const name = await clearName(source.name, request.from);
    const relative = relativeDir === "" ? name : `${relativeDir}/${name}`;
    const target = joinPath(targetDir, await storedName(name, request.to));
    if (source.kind !== "dir") {
      upload(source, target, relative);
      return 1;
    }
    await api.mkdir(target);
    let files = 0;
    for (const child of (await api.list(source.path)).entries) {
      if (child.kind === "file" || child.kind === "dir")
        files += await walk(child, target, relative);
    }
    return files;
  }

  // Names in the listing are the clear ones; the walk reads stored names from fdrive again.
  const stored = new Map(
    (await api.list(parentOf(request.sources))).entries.map((e) => [e.path, e]),
  );
  let files = 0;
  for (const source of request.sources) {
    const entry = stored.get(source.path) ?? source;
    if (entry.kind === "dir") folders.push(entry);
    files += await walk(entry, request.target, "");
  }

  if (request.move && folders.length > 0) {
    // A moved folder goes once its last file has.
    let remaining = files;
    const removeFolders = async () => {
      for (const folder of folders) await deleteForGood(api, folder).catch(() => undefined);
    };
    if (remaining === 0) await removeFolders();
    for (const [index, item] of items.entries()) {
      const after = item.after;
      items[index] = {
        ...item,
        after: async () => {
          await after?.();
          remaining -= 1;
          if (remaining === 0) await removeFolders();
        },
      };
    }
  }
  return items;
}

function parentOf(sources: readonly FsEntry[]): string {
  const first = sources[0]?.path ?? "/";
  const cut = first.lastIndexOf("/");
  return cut <= 0 ? "/" : first.slice(0, cut);
}
