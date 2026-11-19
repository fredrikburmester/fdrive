import { describe, expect, it } from "vitest";
import { browserRemembered } from "./remembered";

/**
 * Just enough of IndexedDB for one object store: requests that succeed or
 * fail on the next turn, and values kept by structured clone, CryptoKeys too.
 */
function fakeIndexedDb(options: { failGet?: boolean } = {}): IDBFactory {
  const values = new Map<string, unknown>();
  let created = false;
  function request<T>(work: () => T, fail = false) {
    const req = {} as IDBRequest<T> & { result: T; error: DOMException | null };
    setTimeout(() => {
      if (fail) {
        req.error = new DOMException("failed");
        req.onerror?.(new Event("error"));
        return;
      }
      req.result = work();
      req.onsuccess?.(new Event("success"));
    }, 0);
    return req;
  }
  const store = {
    put: (value: unknown, key: string) => request(() => values.set(key, structuredClone(value))),
    get: (key: string) => request(() => values.get(key), options.failGet),
    delete: (key: string) => request(() => values.delete(key)),
  };
  const db = {
    createObjectStore: () => {
      created = true;
      return store;
    },
    transaction: () => ({ objectStore: () => store }),
    close: () => undefined,
  };
  return {
    open: () => {
      const req = {} as {
        result: unknown;
        onupgradeneeded?: (event: Event) => void;
        onsuccess?: (event: Event) => void;
      };
      setTimeout(() => {
        req.result = db;
        // A new database is upgraded first, as IndexedDB does.
        if (!created) req.onupgradeneeded?.(new Event("upgradeneeded"));
        req.onsuccess?.(new Event("success"));
      }, 0);
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe("remembering the key on this browser", () => {
  it("keeps an identity for its recipient, sealed under a key the page cannot read", async () => {
    const remembered = browserRemembered(fakeIndexedDb());
    if (remembered === null) throw new Error("expected a store");
    await remembered.save("age1a", "AGE-SECRET-KEY-1ALICE");
    expect(await remembered.load("age1a")).toBe("AGE-SECRET-KEY-1ALICE");
    expect(await remembered.load("age1b")).toBeNull();
    await remembered.forget();
    expect(await remembered.load("age1a")).toBeNull();
  });

  it("reads a damaged copy as nothing", async () => {
    const factory = fakeIndexedDb();
    const remembered = browserRemembered(factory);
    if (remembered === null) throw new Error("expected a store");
    await remembered.save("age1a", "AGE-SECRET-KEY-1ALICE");
    // A second save under another key seals with a new key; swap in the old bytes.
    const db = (await new Promise((resolve) => {
      const opening = factory.open("fdrive-encryption", 1);
      opening.onsuccess = () => resolve(opening.result);
    })) as IDBDatabase;
    const store = db.transaction("keys", "readwrite").objectStore("keys");
    const stored = await new Promise<{ sealed: ArrayBuffer }>((resolve) => {
      const req = store.get("account");
      req.onsuccess = () => resolve(req.result as { sealed: ArrayBuffer });
    });
    await new Promise((resolve) => {
      const req = store.put({ ...stored, sealed: new ArrayBuffer(4) }, "account");
      req.onsuccess = resolve;
    });
    expect(await remembered.load("age1a")).toBeNull();
  });

  it("passes on a failure of the store", async () => {
    const remembered = browserRemembered(fakeIndexedDb({ failGet: true }));
    await expect(remembered?.load("age1a")).rejects.toBeInstanceOf(DOMException);
  });

  it("is absent without IndexedDB", () => {
    expect(browserRemembered(undefined)).toBeNull();
  });
});
