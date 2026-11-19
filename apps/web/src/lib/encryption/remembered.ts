/**
 * Keeps the unlocked account identity on this browser until sign-out, so a
 * reload does not ask for the encryption password again. It is stored in
 * IndexedDB encrypted with an AES-GCM key the browser made non-extractable:
 * page script can use that key but never read it, and the stored bytes
 * alone open nothing.
 */

const DATABASE = "fdrive-encryption";
const STORE = "keys";
const KEY = "account";

interface Stored {
  readonly recipient: string;
  readonly wrapKey: CryptoKey;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly sealed: ArrayBuffer;
}

/** Where the identity is remembered; absent where the browser has no IndexedDB, as in tests. */
export interface Remembered {
  save(recipient: string, identity: string): Promise<void>;
  /** The identity remembered for `recipient`; null when none, or for another key. */
  load(recipient: string): Promise<string | null>;
  forget(): Promise<void>;
}

function request<T>(work: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    work.onsuccess = () => resolve(work.result);
    work.onerror = () => reject(work.error);
  });
}

async function open(factory: IDBFactory): Promise<IDBDatabase> {
  const opening = factory.open(DATABASE, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  return request(opening);
}

async function withStore<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open(factory);
  try {
    return await request(work(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

/** The browser's store, or none where IndexedDB or WebCrypto is missing. */
export function browserRemembered(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Remembered | null {
  if (factory === undefined) return null;
  return {
    async save(recipient, identity) {
      const wrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        wrapKey,
        new TextEncoder().encode(identity),
      );
      const stored: Stored = { recipient, wrapKey, iv, sealed };
      await withStore(factory, "readwrite", (store) => store.put(stored, KEY));
    },
    async load(recipient) {
      const stored = (await withStore(factory, "readonly", (store) => store.get(KEY))) as
        | Stored
        | undefined;
      if (stored === undefined || stored.recipient !== recipient) return null;
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: stored.iv },
          stored.wrapKey,
          stored.sealed,
        );
        return new TextDecoder().decode(plain);
      } catch {
        return null;
      }
    },
    async forget() {
      await withStore(factory, "readwrite", (store) => store.delete(KEY));
    },
  };
}
