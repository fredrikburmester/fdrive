// @vitest-environment jsdom
import type { EncryptionStatus } from "@fdrive/contracts";
import { createAccountKeys, DecryptError } from "@fdrive/crypto";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { encryptedFolder } from "@/test-fixtures/encryption";
import { createKeyStore, keyStore, useKeyState } from "./keys";
import type { Remembered } from "./remembered";

function memory(): Remembered & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    async save(recipient, identity) {
      saved.clear();
      saved.set(recipient, identity);
    },
    async load(recipient) {
      return saved.get(recipient) ?? null;
    },
    async forget() {
      saved.clear();
    },
  };
}

async function status(password = "a long password") {
  const keys = await createAccountKeys(password, { workFactor: 10 });
  const on: EncryptionStatus = {
    enabled: true,
    recipient: keys.recipient,
    passwordKey: keys.passwordKey,
    recoveryKey: keys.recoveryKey,
    devices: [],
    createdAt: new Date(0).toISOString(),
  };
  return { keys, on };
}

describe("the key store", () => {
  it("is off without encryption, and locked until the password opens the key", async () => {
    const store = createKeyStore(memory());
    expect(store.get()).toEqual({ status: "unknown" });
    await store.refresh({ enabled: false });
    expect(store.get()).toEqual({ status: "off" });
    const { keys, on } = await status();
    await store.refresh(on);
    expect(store.get()).toEqual({ status: "locked", recipient: keys.recipient });
    await expect(store.unlock(on.passwordKey, "wrong", keys.recipient)).rejects.toBeInstanceOf(
      DecryptError,
    );
    await store.unlock(on.passwordKey, "a long password", keys.recipient);
    expect(store.get()).toEqual({ status: "unlocked", recipient: keys.recipient });
    expect(store.identity()).toBe(keys.identity);
    // Another refresh keeps it open.
    await store.refresh(on);
    expect(store.get().status).toBe("unlocked");
  });

  it("remembers the key on this browser until it locks", async () => {
    const remembered = memory();
    const { keys, on } = await status();
    const first = createKeyStore(remembered);
    await first.unlocked(keys.identity);
    const next = createKeyStore(remembered);
    await next.refresh(on);
    expect(next.get().status).toBe("unlocked");
    await next.lock();
    expect(next.get()).toEqual({ status: "locked", recipient: keys.recipient });
    expect(remembered.saved.size).toBe(0);
    await next.lock();
    expect(next.get()).toEqual({ status: "unknown" });
  });

  it("drops a key that belongs to another account", async () => {
    const remembered = memory();
    const store = createKeyStore(remembered);
    const old = await status();
    await store.unlocked(old.keys.identity);
    const { keys, on } = await status();
    await store.refresh(on);
    expect(store.get()).toEqual({ status: "locked", recipient: keys.recipient });
    // A remembered identity for the recipient that is not its key is not used.
    remembered.saved.set(keys.recipient, old.keys.identity);
    await store.refresh(on);
    expect(store.get().status).toBe("locked");
  });

  it("works where nothing can be remembered, and where remembering fails", async () => {
    const { keys, on } = await status();
    const plain = createKeyStore(null);
    await plain.unlocked(keys.identity);
    expect(plain.get().status).toBe("unlocked");
    await plain.lock();
    const failing: Remembered = {
      save: () => Promise.reject(new Error("full")),
      load: () => Promise.reject(new Error("gone")),
      forget: () => Promise.reject(new Error("gone")),
    };
    const store = createKeyStore(failing);
    await store.refresh(on);
    expect(store.get().status).toBe("locked");
    await store.unlocked(keys.identity);
    await store.lock();
    expect(store.get().status).toBe("locked");
  });

  it("opens encrypted folders once, and again after a marker that failed", async () => {
    const { identity, info, folder } = await encryptedFolder();
    const store = createKeyStore(null);
    expect(await store.folder(info)).toBeNull();
    await store.unlocked(identity);
    const opened = await store.folder(info);
    expect(opened?.id).toBe(folder.id);
    expect(await store.folder(info)).toBe(await store.folder(info));
    const forged = { ...info, marker: { ...info.marker, mac: `${"B".repeat(43)}=` } };
    await expect(store.folder(forged)).rejects.toBeInstanceOf(DecryptError);
    await expect(store.folder(forged)).rejects.toBeInstanceOf(DecryptError);
  });

  it("re-renders whoever reads its state", async () => {
    const store = createKeyStore(null);
    const { result, unmount } = renderHook(() => useKeyState(store));
    expect(result.current.status).toBe("unknown");
    await act(() => store.refresh({ enabled: false }));
    expect(result.current.status).toBe("off");
    unmount();
    expect(renderHook(() => useKeyState()).result.current).toBe(keyStore.get());
  });
});
