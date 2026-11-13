import type { StorageProvider } from "@fdrive/core";
import { createLocalStorage } from "@fdrive/local";
import { startLocalStorage } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OfficeHarness, officeHarness } from "../fixtures/office/harness.ts";

// The harness maps every login to one folder, so each user's storage below is
// the same real folder on disk. The reader is held to viewing by Office's
// edit policy, never by the storage.
describe("WOPI over a real local folder", () => {
  let storage: Awaited<ReturnType<typeof startLocalStorage>> | undefined;
  let h: OfficeHarness;
  const storages = new Map<string, StorageProvider>();
  beforeAll(async () => {
    storage = await startLocalStorage({
      users: [{ username: "alice", password: "alice-pass" }],
      files: { alice: { "/a.docx": "original", "/empty.docx": "" } },
    });
    for (const username of ["alice", "bob", "reader"]) {
      storages.set(username, createLocalStorage({ home: storage.path("alice") }));
    }
    h = await officeHarness({
      storageForUser: (username) => {
        const found = storages.get(username);
        if (found === undefined) throw new Error("Unknown test user");
        return found;
      },
    });
  }, 180000);
  afterAll(async () => {
    await storage?.stop();
  }, 180000);
  it("shares UUID and lock across two credentials, streams saved bytes, permits readonly view", async () => {
    const a = await h.open();
    const b = await h.open("/a.docx", "edit", h.bob);
    expect(a.fileId).toBe(b.fileId);
    const lock = await h.callback(a, {
      method: "POST",
      headers: { "X-WOPI-Override": "LOCK", "X-WOPI-Lock": "shared-editor" },
    });
    expect(lock.status).toBe(200);
    const save = await h.callback(b, {
      method: "POST",
      contents: true,
      headers: { "X-WOPI-Override": "PUT", "X-WOPI-Lock": "shared-editor" },
      body: "saved by bob åäö",
    });
    expect(save.status).toBe(200);
    expect(save.headers.get("X-WOPI-ItemVersion")).toBeTruthy();
    const aliceStorage = storages.get("alice");
    if (!aliceStorage) throw new Error("Missing storage");
    expect(await new Response((await aliceStorage.download("/a.docx")).body).text()).toBe(
      "saved by bob åäö",
    );
    const view = await h.open("/a.docx", "view", h.reader);
    expect((await h.callback(view)).status).toBe(200);
    expect(
      (
        await h.callback(view, {
          method: "POST",
          headers: { "X-WOPI-Override": "LOCK", "X-WOPI-Lock": "view-only" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.callback(view, {
          method: "POST",
          contents: true,
          headers: { "X-WOPI-Override": "PUT", "X-WOPI-Lock": "shared-editor" },
          body: "denied",
        })
      ).status,
    ).toBe(403);
    await expect(h.open("/a.docx", "edit", h.reader)).rejects.toMatchObject({ status: 403 });
    expect(await (await h.callback(view)).json()).toMatchObject({
      UserCanWrite: false,
      ReadOnly: true,
    });
    expect(await (await h.callback(view)).json()).not.toHaveProperty("HostEditUrl");
  });
  it("saves a Unicode sibling then renames original with stable UUID and real bytes", async () => {
    const opened = await h.open();
    const relative = await h.callback(opened, {
      method: "POST",
      headers: {
        "X-WOPI-Override": "PUT_RELATIVE",
        "X-WOPI-RelativeTarget": "+AMU-rsrapport.docx",
      },
      body: "copy bytes",
    });
    expect(relative.status).toBe(200);
    const renamed = await h.callback(opened, {
      method: "POST",
      headers: {
        "X-WOPI-Override": "RENAME_FILE",
        "X-WOPI-Lock": "shared-editor",
        "X-WOPI-RequestedName": "Renamed",
      },
    });
    expect(renamed.status).toBe(200);
    expect((await h.open("/Renamed.docx", "edit", h.bob)).fileId).toBe(opened.fileId);
    const bobStorage = storages.get("bob");
    if (!bobStorage) throw new Error("Missing storage");
    expect(await new Response((await bobStorage.download("/Årsrapport.docx")).body).text()).toBe(
      "copy bytes",
    );
    expect(await new Response((await bobStorage.download("/Renamed.docx")).body).text()).toBe(
      "saved by bob åäö",
    );
  });
});
