"use client";

import type { FsEntry } from "@fdrive/contracts";
import { joinPath, parentPath } from "@fdrive/core";
import { createFolder, encryptName } from "@fdrive/crypto";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import type { PrepareUploads } from "@/components/upload/use-upload-files";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { fetchDecrypted, tooLargeToDecrypt } from "@/lib/encryption/content";
import { type KeyStore, keyStore } from "@/lib/encryption/keys";
import type { EncryptedView, ShownEntry } from "@/lib/encryption/listing";
import { crossesEdge, planTransfer, type Side } from "@/lib/encryption/transfer";
import { prepareEncryptedUploads } from "@/lib/encryption/upload";
import { useUploadStore } from "@/lib/upload/store";

/** Said whenever this browser has no key for an encrypted folder it is asked to use. */
export const LOCKED_MESSAGE = "Unlock encryption in Account to use this encrypted folder.";

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

export interface EncryptedActionsDeps {
  readonly store?: KeyStore;
  /** Saves a decrypted file under its clear name. */
  readonly save: (blob: Blob, name: string) => void;
}

/**
 * What the file browser does differently in and around encrypted folders:
 * names it stores are encrypted, uploads encrypt each file, downloads
 * decrypt, and a move or copy across an encrypted folder's edge runs in the
 * browser as uploads in the dock.
 */
export function useEncryptedActions(
  view: EncryptedView,
  path: string,
  entries: readonly FsEntry[],
  deps: EncryptedActionsDeps,
) {
  const store = deps.store ?? keyStore;
  const queryClient = useQueryClient();
  const enqueue = useUploadStore((state) => state.enqueue);
  const inside = view.kind !== "plain";
  const open = view.kind === "open" ? view : null;
  const storedByName = useMemo(
    () => new Map((open?.entries ?? []).map((entry) => [entry.name, entry.storedName])),
    [open],
  );

  /** The name to store for `name` in this folder: encrypted inside an encrypted folder. */
  async function nameFor(name: string): Promise<string> {
    if (!inside) return name;
    if (open === null) throw new Error(LOCKED_MESSAGE);
    return encryptName(name, open.folder.nameKey, open.folder.id);
  }

  /** An entry's name as fdrive stores it, for requests that name it. */
  function storedName(entry: FsEntry): string {
    return (entry as Partial<ShownEntry>).storedName ?? entry.name;
  }

  const prepareUploads: PrepareUploads | undefined =
    open === null
      ? undefined
      : async (items) => {
          try {
            return await prepareEncryptedUploads(items, {
              destination: path,
              folder: open.folder,
              storedByName,
            });
          } catch (error) {
            toast.error(message(error, "Could not encrypt the upload."));
            throw error;
          }
        };

  /** Why nothing can be uploaded here now, or null. */
  const uploadBlock = inside && open === null ? LOCKED_MESSAGE : null;

  /** The encrypted folder `folder` is in, opened; null outside one. */
  async function sideOf(folder: string): Promise<Side> {
    if (folder === path && view.kind !== "locked") return open?.folder ?? null;
    const info = (await apiClient.encryptedFolder(folder)).folder;
    if (info === null) return null;
    const key = await store.folder(info);
    if (key === null) throw new Error(LOCKED_MESSAGE);
    return key;
  }

  /**
   * Moves or copies `sources` into `target` through the browser when that
   * crosses an encrypted folder's edge. False when it does not, and the
   * caller moves or copies as usual.
   */
  async function transfer(
    sources: readonly string[],
    target: string,
    move: boolean,
  ): Promise<boolean> {
    if (sources.length === 0) return false;
    try {
      const to = await sideOf(target);
      const parents = [...new Set(sources.map(parentPath))];
      const froms = await Promise.all(parents.map(sideOf));
      const from = froms[0] ?? null;
      if (!froms.some((side) => crossesEdge(side, to))) return false;
      if (parents.length > 1) {
        throw new Error("Move items from one folder at a time into or out of an encrypted folder.");
      }
      const known = new Map(entries.map((entry) => [entry.path, entry]));
      const picked = sources.map(
        (source) =>
          known.get(source) ?? {
            name: source.split("/").at(-1) ?? source,
            path: source,
            kind: "file" as const,
            size: 0,
            modifiedAt: new Date(0).toISOString(),
            ext: "",
            mime: null,
          },
      );
      if (to !== null && picked.some((entry) => entry.encrypted === true)) {
        throw new Error("An encrypted folder cannot go inside another.");
      }
      const items = await planTransfer(
        { sources: picked, from, target, to, move },
        { api: apiClient, fetch: globalThis.fetch.bind(globalThis), id: () => crypto.randomUUID() },
      );
      enqueue(items);
      return true;
    } catch (error) {
      toast.error(message(error, move ? "Could not move." : "Could not copy."));
      return true;
    }
  }

  /** Downloads files of this encrypted folder decrypted. False outside one. */
  async function download(targets: readonly FsEntry[]): Promise<boolean> {
    if (!inside) return false;
    if (open === null) {
      toast.error(LOCKED_MESSAGE);
      return true;
    }
    for (const target of targets) {
      if (target.kind === "dir") {
        toast.error("Folders in an encrypted folder download one file at a time.");
        continue;
      }
      const tooLarge = tooLargeToDecrypt(target.size);
      if (tooLarge !== null) {
        toast.error(tooLarge);
        continue;
      }
      try {
        const blob = await fetchDecrypted(
          apiClient.downloadUrl(target.path),
          open.folder.identity,
          target.mime ?? "",
        );
        deps.save(blob, target.name);
      } catch (error) {
        toast.error(message(error, `Could not download ${target.name}.`));
      }
    }
    return true;
  }

  /** Makes a new encrypted folder named `name` here, with keys made in this browser. */
  async function createEncryptedFolder(name: string): Promise<string> {
    const identity = store.identity();
    if (identity === null) throw new Error("Turn encryption on, or unlock it, in Account first.");
    const { marker } = await createFolder(identity);
    const created = await apiClient.createEncryptedFolder({ path: joinPath(path, name), marker });
    await queryClient.invalidateQueries({ queryKey: queryKeys.fs.list(path) });
    return created.path;
  }

  return {
    inside,
    open,
    nameFor,
    storedName,
    prepareUploads,
    uploadBlock,
    transfer,
    download,
    createEncryptedFolder,
  };
}
