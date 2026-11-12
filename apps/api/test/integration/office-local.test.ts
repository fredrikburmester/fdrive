import type { StorageProvider } from "@fdrive/core";
import { createSftpgoClient, createSftpgoStorageProvider } from "@fdrive/sftpgo";
import { type SftpgoContainer, startSftpgo } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type OfficeHarness, officeHarness } from "../fixtures/office/harness.ts";

// Isolated fixture administration configures a shared home. Application requests
// below use only each user's own credentials, including the read-only identity.
describe("WOPI over real SFTPGo storage", () => {
  let container: SftpgoContainer | undefined;
  let h: OfficeHarness;
  const storages = new Map<string, StorageProvider>();
  beforeAll(async () => {
    container = await startSftpgo({
      users: [
        { username: "alice", password: "alice-pass", permissions: { "/": ["*"] } },
        { username: "bob", password: "bob-pass", permissions: { "/": ["*"] } },
        { username: "reader", password: "reader-pass", permissions: { "/": ["list", "download"] } },
      ],
      folders: [],
      files: { alice: { "/a.docx": "original", "/empty.docx": "" } },
    });
    const tokenResponse = await fetch(`${container.baseUrl}/api/v2/token`, {
      headers: {
        Authorization: `Basic ${Buffer.from("admin:admin-password-for-tests").toString("base64")}`,
      },
    });
    expect(tokenResponse.ok).toBe(true);
    const admin = z
      .object({ access_token: z.string() })
      .parse(await tokenResponse.json()).access_token;
    for (const username of ["bob", "reader"]) {
      const userResponse = await fetch(`${container.baseUrl}/api/v2/users/${username}`, {
        headers: { Authorization: `Bearer ${admin}` },
      });
      expect(userResponse.ok).toBe(true);
      const user = z.record(z.string(), z.unknown()).parse(await userResponse.json());
      const updated = await fetch(`${container.baseUrl}/api/v2/users/${username}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...user, home_dir: "/srv/sftpgo/data/alice" }),
      });
      expect(updated.ok).toBe(true);
    }
    const client = createSftpgoClient({ baseUrl: container.baseUrl });
    for (const username of ["alice", "bob", "reader"]) {
      const token = await client.login({ username, password: `${username}-pass` });
      storages.set(
        username,
        createSftpgoStorageProvider({ client, withToken: async (fn) => fn(token.accessToken) }),
      );
    }
    h = await officeHarness({
      storageForUser: (username) => {
        const storage = storages.get(username);
        if (storage === undefined) throw new Error("Unknown test user");
        return storage;
      },
    });
  }, 180000);
  afterAll(async () => {
    await container?.stop();
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
