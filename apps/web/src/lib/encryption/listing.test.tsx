// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { encryptedSize } from "@fdrive/crypto";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { encryptedEntry, encryptedFolder, stored } from "@/test-fixtures/encryption";
import { createKeyStore } from "./keys";
import { crumbNames, showEntries, showEntry, UNREADABLE_NAME, useEncryptedView } from "./listing";

describe("showing an encrypted folder's entries", () => {
  it("shows the decrypted name, its type and the plaintext size", async () => {
    const { folder } = await encryptedFolder();
    const file = await encryptedEntry("/Private", "Kvitto.pdf", folder, "file", encryptedSize(10));
    const shown = await showEntry(file, folder);
    expect(shown).toMatchObject({
      name: "Kvitto.pdf",
      path: file.path,
      storedName: file.name,
      ext: ".pdf",
      mime: "application/pdf",
      size: 10,
      stray: false,
    });
    const dir = await showEntry(
      await encryptedEntry("/Private", "Photos", folder, "dir", 64),
      folder,
    );
    expect(dir).toMatchObject({ name: "Photos", ext: "", mime: null, size: 64 });
    // A size no age file has stays as stored.
    const odd = await showEntry(await encryptedEntry("/Private", "a", folder, "file", 3), folder);
    expect(odd.size).toBe(3);
  });

  it("keeps a clear name a writer outside fdrive left, and names a broken one", async () => {
    const { folder } = await encryptedFolder();
    const other = (await encryptedFolder()).folder;
    const [stray, broken] = await showEntries(
      [stored("/Private", "dropped.txt"), await encryptedEntry("/Private", "x", other)],
      folder,
    );
    expect(stray).toMatchObject({ name: "dropped.txt", stray: true });
    expect(broken).toMatchObject({ name: UNREADABLE_NAME, stray: true });
  });

  it("decrypts the folders on the path below the encrypted folder for breadcrumbs", async () => {
    const { folder, info } = await encryptedFolder("/Home/Private");
    const a = await encryptedEntry("/Home/Private", "2026", folder, "dir");
    const b = await encryptedEntry(a.path, "Taxes", folder, "dir");
    const names = await crumbNames(`${b.path}/fe1-unknown`, info, folder);
    expect([...names.values()]).toEqual(["2026", "Taxes", "fe1-unknown"]);
    expect(names.has("/Home/Private")).toBe(false);
  });
});

/** One empty listing: the file browser passes the same array until its listing changes. */
const NONE: FsEntry[] = [];

describe("useEncryptedView", () => {
  it("passes a plain folder through", () => {
    const store = createKeyStore(null);
    // New arrays on every render, as a careless caller passes, settle on one view.
    const { result } = renderHook(() => useEncryptedView("/", undefined, [], store));
    expect(result.current.kind).toBe("plain");
  });

  it("is locked without the key, then opens with decrypted entries", async () => {
    const { folder, info, identity } = await encryptedFolder();
    const entries = [await encryptedEntry("/Private", "a.txt", folder)];
    const store = createKeyStore(null);
    const { result } = renderHook(() => useEncryptedView("/Private", info, entries, store));
    expect(result.current.kind).toBe("locked");
    await store.unlocked(identity);
    await waitFor(() => expect(result.current.kind).toBe("open"));
    const view = result.current;
    expect(view.kind === "open" && view.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  it("says when the folder's marker does not open with this key", async () => {
    const { info } = await encryptedFolder();
    const store = createKeyStore(null);
    await store.unlocked((await encryptedFolder()).identity);
    const { result } = renderHook(() => useEncryptedView("/Private", info, NONE, store));
    await waitFor(() => expect(result.current.kind).toBe("broken"));
  });

  it("goes back to locked when the key goes while it opens", async () => {
    const { info, identity } = await encryptedFolder();
    const store = createKeyStore(null);
    await store.unlocked(identity);
    const { result, rerender } = renderHook(
      ({ path }) => useEncryptedView(path, info, NONE, store),
      {
        initialProps: { path: "/Private" },
      },
    );
    await store.lock();
    rerender({ path: "/Private" });
    await waitFor(() => expect(result.current.kind).toBe("locked"));
  });
});
