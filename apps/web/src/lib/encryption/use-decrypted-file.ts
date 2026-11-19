"use client";

import type { FsEntry } from "@fdrive/contracts";
import type { FolderKey } from "@fdrive/crypto";
import { useEffect, useState } from "react";
import { BROWSER_LIMIT, fetchDecrypted, PREVIEW_LIMIT } from "./content";

/** A file of an encrypted folder, decrypted in memory for the viewer. */
export type DecryptedFile =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  /** Too large for the viewer: it downloads instead, or opens only on the Mac. */
  | { readonly status: "too-large"; readonly downloadable: boolean }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error"; readonly message: string };

export interface DecryptedFileDeps {
  readonly fetchDecrypted?: typeof fetchDecrypted;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

/**
 * Downloads and decrypts `entry` (shown with its decrypted name and type)
 * with its folder's key, as an object URL the viewers read like any other,
 * released when the file changes or the page closes.
 */
export function useDecryptedFile(
  entry: FsEntry | undefined,
  folder: FolderKey | null,
  url: string,
  deps: DecryptedFileDeps = {},
): DecryptedFile {
  const [state, setState] = useState<DecryptedFile>({ status: "idle" });
  const decrypt = deps.fetchDecrypted ?? fetchDecrypted;
  const create = deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revoke = deps.revokeObjectUrl ?? ((objectUrl: string) => URL.revokeObjectURL(objectUrl));

  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the caller's fixed seams
  useEffect(() => {
    if (entry === undefined || folder === null) {
      setState({ status: "idle" });
      return;
    }
    if (entry.size > PREVIEW_LIMIT) {
      setState({ status: "too-large", downloadable: entry.size <= BROWSER_LIMIT });
      return;
    }
    let current = true;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    decrypt(url, folder.identity, entry.mime ?? "").then(
      (blob) => {
        if (!current) return;
        objectUrl = create(blob);
        setState({ status: "ready", url: objectUrl });
      },
      (error: unknown) => {
        if (!current) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "This file could not be decrypted.",
        });
      },
    );
    return () => {
      current = false;
      if (objectUrl !== null) revoke(objectUrl);
    };
  }, [entry?.path, entry?.size, entry?.mime, folder, url]);

  return state;
}
