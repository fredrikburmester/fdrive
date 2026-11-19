"use client";

import type { EncryptedEntry, FsEntry, SearchHit } from "@fdrive/contracts";
import { extensionOf, mimeFromExtension, splitSegments } from "@fdrive/core";
import { decryptedSize, decryptName, type FolderKey } from "@fdrive/crypto";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { keyStore, useKeyState } from "./keys";

/** What name search inside an encrypted folder found: folders, and files as search hits. */
export interface EncryptedMatches {
  readonly folders: FsEntry[];
  /** Files, each with `where`: its folder's path with decrypted names, for showing. */
  readonly files: (SearchHit & { readonly where: string })[];
}

const NONE: EncryptedMatches = { folders: [], files: [] };

/** Folds case and accent encoding, so "möte" finds "Möte" whichever way it was typed. */
function fold(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase();
}

/**
 * The entries of an encrypted folder whose decrypted name contains `query`,
 * at most `limit` of each kind. Each name is decrypted once, so a folder of a
 * few thousand entries takes a fraction of a second.
 */
export async function matchEncryptedNames(
  entries: readonly EncryptedEntry[],
  root: string,
  folder: FolderKey,
  query: string,
  limit = 50,
): Promise<EncryptedMatches> {
  const wanted = fold(query.trim());
  if (wanted === "") return NONE;
  const top = splitSegments(root).length;
  const clear = new Map<string, string | null>();
  async function nameOf(stored: string): Promise<string | null> {
    if (!clear.has(stored)) clear.set(stored, await decryptName(stored, folder.nameKey, folder.id));
    return clear.get(stored) ?? null;
  }
  const folders: FsEntry[] = [];
  const files: (SearchHit & { readonly where: string })[] = [];
  for (const entry of entries) {
    if (folders.length >= limit && files.length >= limit) break;
    const segments = splitSegments(entry.path);
    const stored = segments.at(-1) ?? "";
    const name = await nameOf(stored);
    if (name === null || !fold(name).includes(wanted)) continue;
    // Where it is, as the person knows it: the folder's own name, then decrypted names.
    const above = await Promise.all(segments.slice(top, -1).map(nameOf));
    const where = [
      "",
      ...segments.slice(0, top),
      ...above.map((part, index) => part ?? segments[top + index]),
    ].join("/");
    const ext = entry.kind === "dir" ? "" : extensionOf(name);
    const shown = {
      name,
      path: entry.path,
      kind: entry.kind,
      size: entry.kind === "dir" ? entry.size : (decryptedSize(entry.size) ?? entry.size),
      modifiedAt: entry.modifiedAt,
      ext,
      mime: entry.kind === "dir" ? null : mimeFromExtension(ext),
    };
    if (entry.kind === "dir") {
      if (folders.length < limit) folders.push(shown);
    } else if (files.length < limit) {
      files.push({
        ...shown,
        path: entry.path,
        score: 1,
        snippets: [],
        hasThumbnail: false,
        where,
      });
    }
  }
  return { folders, files };
}

/**
 * Name search inside the encrypted folder `folder` is in, while this browser
 * holds the key: the server cannot search names it cannot read. Empty
 * anywhere else, and while locked.
 */
export function useEncryptedSearch(query: string, folder: string, enabled: boolean) {
  const keys = useKeyState();
  const info = useQuery({
    queryKey: queryKeys.encryption.folder(folder),
    enabled: enabled && keys.status === "unlocked",
    queryFn: async () => (await apiClient.encryptedFolder(folder)).folder,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const root = info.data?.path ?? null;
  const entries = useQuery({
    queryKey: queryKeys.encryption.entries(root ?? ""),
    enabled: root !== null,
    queryFn: () => apiClient.encryptedEntries(root ?? "/"),
    staleTime: 30_000,
  });
  return useQuery({
    queryKey: ["encryption", "matches", root, query, entries.dataUpdatedAt] as const,
    enabled: info.data !== undefined && info.data !== null && entries.data !== undefined,
    gcTime: 0,
    queryFn: async (): Promise<EncryptedMatches> => {
      if (info.data === undefined || info.data === null || entries.data === undefined) return NONE;
      const key = await keyStore.folder(info.data);
      if (key === null) return NONE;
      return matchEncryptedNames(entries.data.entries, info.data.path, key, query);
    },
  });
}

/** The server's search sections with encrypted-folder matches first; the server's unchanged without any. */
export function withEncryptedMatches<
  S extends { folders: FsEntry[]; files: SearchHit[]; content: SearchHit[] },
>(sections: S | undefined, matches: EncryptedMatches | undefined): S | undefined {
  if (matches === undefined || (matches.folders.length === 0 && matches.files.length === 0)) {
    return sections;
  }
  return {
    ...(sections ?? { content: [] }),
    folders: [...matches.folders, ...(sections?.folders ?? [])],
    files: [...matches.files, ...(sections?.files ?? [])],
    content: sections?.content ?? [],
  } as S;
}
