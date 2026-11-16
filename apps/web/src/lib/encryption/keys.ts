"use client";

import type { EncryptedFolderInfo, EncryptionStatus } from "@fdrive/contracts";
import { type FolderKey, openFolder, recipientOf, unlockWithPassword } from "@fdrive/crypto";
import { useSyncExternalStore } from "react";
import { browserRemembered, type Remembered } from "./remembered";

/**
 * The signed-in person's encryption keys in this browser. The unlocked
 * account identity lives here, outside React state, and is remembered on
 * this browser until sign-out (see `remembered.ts`). Nothing in it is ever
 * sent to the server.
 */
export type KeyState =
  /** Not asked yet. */
  | { readonly status: "unknown" }
  /** Encryption is not on for this login. */
  | { readonly status: "off" }
  /** On, but this browser has not been given the encryption password. */
  | { readonly status: "locked"; readonly recipient: string }
  | { readonly status: "unlocked"; readonly recipient: string };

export interface KeyStore {
  get(): KeyState;
  subscribe(listener: () => void): () => void;
  /** Takes the server's status, and the identity this browser remembers for it. */
  refresh(status: EncryptionStatus): Promise<void>;
  /** Opens the account key with the encryption password; a wrong one throws `DecryptError`. */
  unlock(passwordKey: string, password: string, recipient: string): Promise<void>;
  /** Uses an account identity opened another way: just made, or from the recovery key. */
  unlocked(identity: string): Promise<void>;
  /** The unlocked account identity; null while locked. */
  identity(): string | null;
  /** Forgets the identity here, as signing out does. */
  lock(): Promise<void>;
  /** Opens an encrypted folder; null while locked. Throws `DecryptError` for a bad marker. */
  folder(info: EncryptedFolderInfo): Promise<FolderKey | null>;
}

export function createKeyStore(remembered: Remembered | null): KeyStore {
  let state: KeyState = { status: "unknown" };
  let identity: string | null = null;
  const folders = new Map<string, Promise<FolderKey>>();
  const listeners = new Set<() => void>();

  function set(next: KeyState) {
    state = next;
    for (const listener of listeners) listener();
  }

  async function use(next: string) {
    const recipient = await recipientOf(next);
    identity = next;
    folders.clear();
    await remembered?.save(recipient, next).catch(() => undefined);
    set({ status: "unlocked", recipient });
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh(status) {
      if (!status.enabled) {
        identity = null;
        folders.clear();
        set({ status: "off" });
        return;
      }
      if (identity !== null && (await recipientOf(identity)) === status.recipient) {
        set({ status: "unlocked", recipient: status.recipient });
        return;
      }
      identity = null;
      folders.clear();
      const saved = await remembered?.load(status.recipient).catch(() => null);
      if (
        saved !== null &&
        saved !== undefined &&
        (await recipientOf(saved)) === status.recipient
      ) {
        identity = saved;
        set({ status: "unlocked", recipient: status.recipient });
        return;
      }
      set({ status: "locked", recipient: status.recipient });
    },
    async unlock(passwordKey, password, recipient) {
      await use(await unlockWithPassword(passwordKey, password, recipient));
    },
    unlocked: use,
    identity: () => identity,
    async lock() {
      const recipient = state.status === "unlocked" ? state.recipient : null;
      identity = null;
      folders.clear();
      await remembered?.forget().catch(() => undefined);
      set(recipient === null ? { status: "unknown" } : { status: "locked", recipient });
    },
    async folder(info) {
      if (identity === null) return null;
      const cacheKey = `${info.path}\u0000${info.marker.id}\u0000${info.marker.mac}`;
      let opened = folders.get(cacheKey);
      if (opened === undefined) {
        opened = openFolder(info.marker, identity);
        folders.set(cacheKey, opened);
        // A marker that does not open is asked again next time, not cached as broken.
        opened.catch(() => folders.delete(cacheKey));
      }
      return opened;
    },
  };
}

/** The browser's one key store. */
export const keyStore = createKeyStore(typeof window === "undefined" ? null : browserRemembered());

/** The key state, re-rendering when it changes. */
export function useKeyState(store: KeyStore = keyStore): KeyState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
