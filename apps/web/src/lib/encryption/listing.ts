"use client";

import { type EncryptedFolderInfo, type FsEntry, isEncryptedName } from "@fdrive/contracts";
import { extensionOf, mimeFromExtension, splitSegments } from "@fdrive/core";
import { decryptedSize, decryptName, type FolderKey } from "@fdrive/crypto";
import { useEffect, useState } from "react";
import { type KeyStore, keyStore, useKeyState } from "./keys";

/** An entry of an encrypted folder as the browser shows it. */
export interface ShownEntry extends FsEntry {
  /** Its name on disk, which every request uses; `name` is the decrypted one. */
  readonly storedName: string;
  /** Something a writer outside fdrive left: its name does not decrypt. */
  readonly stray: boolean;
}

/** The name shown for something whose stored name does not decrypt. */
export const UNREADABLE_NAME = "Unreadable item";

/** An entry with its decrypted name, the type that name implies, and its plaintext size. */
export async function showEntry(entry: FsEntry, folder: FolderKey): Promise<ShownEntry> {
  const name = await decryptName(entry.name, folder.nameKey, folder.id);
  if (name === null) {
    // A clear name a writer outside fdrive left keeps it; a broken one says so.
    const shown = isEncryptedName(entry.name) ? UNREADABLE_NAME : entry.name;
    return { ...entry, name: shown, storedName: entry.name, stray: true };
  }
  const ext = entry.kind === "dir" ? "" : extensionOf(name);
  const size = entry.kind === "dir" ? entry.size : (decryptedSize(entry.size) ?? entry.size);
  return {
    ...entry,
    name,
    ext,
    size,
    mime: entry.kind === "dir" ? null : mimeFromExtension(ext),
    storedName: entry.name,
    stray: false,
  };
}

/** Every entry of a listing, decrypted. */
export function showEntries(entries: readonly FsEntry[], folder: FolderKey): Promise<ShownEntry[]> {
  return Promise.all(entries.map((entry) => showEntry(entry, folder)));
}

/**
 * The clear names of the folders on `path` below the encrypted folder, by
 * their path, for breadcrumbs and titles. A segment that does not decrypt
 * keeps its stored name.
 */
export async function crumbNames(
  path: string,
  info: EncryptedFolderInfo,
  folder: FolderKey,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const segments = splitSegments(path);
  const top = splitSegments(info.path).length;
  for (let index = top; index < segments.length; index += 1) {
    const stored = segments[index] as string;
    const at = `/${segments.slice(0, index + 1).join("/")}`;
    names.set(at, (await decryptName(stored, folder.nameKey, folder.id)) ?? stored);
  }
  return names;
}

/** How the file browser shows a folder: as it is, or as an encrypted folder. */
export type EncryptedView =
  | { readonly kind: "plain" }
  /** Encrypted, and this browser has no key yet. */
  | { readonly kind: "locked"; readonly info: EncryptedFolderInfo }
  /** Encrypted, its key opening. */
  | { readonly kind: "opening"; readonly info: EncryptedFolderInfo }
  /** The folder's marker does not open with this key. */
  | { readonly kind: "broken"; readonly info: EncryptedFolderInfo }
  | {
      readonly kind: "open";
      readonly info: EncryptedFolderInfo;
      readonly folder: FolderKey;
      readonly entries: readonly ShownEntry[];
      readonly crumbs: ReadonlyMap<string, string>;
    };

const PLAIN: EncryptedView = { kind: "plain" };

/**
 * Decrypts a listing of an encrypted folder once its key is open. A plain
 * folder's listing passes through untouched.
 */
export function useEncryptedView(
  path: string,
  info: EncryptedFolderInfo | undefined,
  entries: readonly FsEntry[],
  store: KeyStore = keyStore,
): EncryptedView {
  const keys = useKeyState(store);
  const [view, setView] = useState<EncryptedView>(PLAIN);
  useEffect(() => {
    // Unchanged views keep their object, so a caller passing new arrays never loops.
    if (info === undefined) {
      setView((previous) => (previous.kind === "plain" ? previous : PLAIN));
      return;
    }
    if (keys.status !== "unlocked") {
      setView((previous) =>
        previous.kind === "locked" && previous.info === info ? previous : { kind: "locked", info },
      );
      return;
    }
    let current = true;
    setView({ kind: "opening", info });
    store
      .folder(info)
      .then(async (folder) => {
        if (folder === null) return { kind: "locked", info } as const;
        const [shown, crumbs] = await Promise.all([
          showEntries(entries, folder),
          crumbNames(path, info, folder),
        ]);
        return { kind: "open", info, folder, entries: shown, crumbs } as const;
      })
      .then(
        (next) => {
          if (current) setView(next);
        },
        () => {
          if (current) setView({ kind: "broken", info });
        },
      );
    return () => {
      current = false;
    };
  }, [path, info, entries, keys.status, store]);
  return view;
}
