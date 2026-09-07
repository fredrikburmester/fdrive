import { generateKeyPairSync, randomUUID } from "node:crypto";
import { parseHomeTemplate, StorageError, scopesFor } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { officeHarness, proofKey } from "../../test/fixtures/office/harness.ts";
import { createOfficeService, fileExists } from "./service.ts";

describe("office opening and creation", () => {
  it("lists actions, opens shared canonical IDs for two users, hashes every new open", async () => {
    const h = await officeHarness();
    expect((await h.service.status()).available).toBe(true);
    const a = await h.open();
    const b = await h.open("/a.docx", "edit", h.bob);
    expect(a.fileId).toBe(b.fileId);
    expect(a.identityId).not.toBe(b.identityId);
    expect(a.actionUrl).toContain("https://app.test/onlyoffice/editor?");
    expect(a.formFields.access_token_ttl).toBe(String(h.clock().getTime() + 8 * 3600000));
    const before = (await (await h.callback(a)).json()) as { Version: string };
    await h.storage.upload("/a.docx", Buffer.from("world"));
    await h.open();
    const after = (await (await h.callback(a)).json()) as { Version: string; Size: number };
    expect(before.Version).not.toBe(after.Version);
    expect(after.Size).toBe(5);
    expect((await h.deps.metadata.listRecents(h.alice.identity.id))[0]?.path).toBe("/a.docx");
  });
  it("returns quiet unavailable status for missing config and discovery failure", async () => {
    const h = await officeHarness();
    expect(await createOfficeService({ ...h.deps, config: null }).status()).toMatchObject({
      available: false,
      product: null,
    });
    expect(await createOfficeService({ ...h.deps, discovery: null }).status()).toMatchObject({
      available: false,
    });
    h.cache.get = async () => {
      throw new Error("private http://internal");
    };
    expect((await h.service.status()).available).toBe(false);
  });
  it("rejects alien discovery origins", async () => {
    const h = await officeHarness();
    h.discovery.actions[0] = {
      extension: "docx",
      name: "edit",
      url: "https://alien/editor",
      zone: "x",
      app: "x",
    };
    expect((await h.service.status()).available).toBe(false);
    await expect(h.open()).rejects.toMatchObject({ status: 502 });
  });
  it("supports conversion and Collabora form fields", async () => {
    const h = await officeHarness({ config: { product: "collabora" } });
    const open = await h.open("/legacy.doc", "convert");
    expect(open.mode).toBe("convert");
    expect(open.formFields.docs_api_config).toBeUndefined();
    await expect(h.open("/a.exe")).rejects.toMatchObject({ status: 400 });
  });
  it.each(["docx", "xlsx", "pptx", "odt", "ods", "odp"])(
    "creates a valid %s package without overwrite",
    async (ext) => {
      const h = await officeHarness();
      const input = { principal: h.alice.principal, sessionId: h.alice.sessionId };
      const request = { parent: "/", name: `New.${ext}` };
      const created = await h.service.create(input, request);
      expect(created.path).toBe(`/New.${ext}`);
      const bytes = await new Response((await h.storage.download(created.path)).body).arrayBuffer();
      expect(Buffer.from(bytes).subarray(0, 2).toString()).toBe("PK");
      await expect(h.service.create(input, request)).rejects.toMatchObject({ status: 409 });
      expect(h.events.at(-1)?.type).toBe("fs");
    },
  );
  it("serializes concurrent creates and catches a collision on the final check", async () => {
    const h = await officeHarness();
    const input = { principal: h.alice.principal, sessionId: h.alice.sessionId };
    const result = await Promise.allSettled([
      h.service.create(input, { parent: "/", name: "New.docx" }),
      h.service.create(input, { parent: "/", name: "New.docx" }),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stat = vi
      .spyOn(h.storage, "statFile")
      .mockRejectedValueOnce(new StorageError("not_found", "missing"))
      .mockResolvedValueOnce({ size: 1, modifiedAt: null, contentType: null });
    await expect(h.service.create(input, { parent: "/", name: "Race.docx" })).rejects.toMatchObject(
      { status: 409 },
    );
    stat.mockRestore();
  });
  it("preserves storage denial and directory collisions", async () => {
    const h = await officeHarness();
    await h.storage.mkdir("/directory.docx");
    expect(
      await fileExists(
        {
          identity: h.alice.identity,
          session: h.alice.session,
          storage: h.storage,
          scopes: scopesFor({
            template: parseHomeTemplate("sftpgo:/shared"),
            username: h.alice.identity.externalUsername,
          }),
        },
        "/directory.docx",
      ),
    ).toBe(true);
    vi.spyOn(h.storage, "statFile").mockRejectedValue(new StorageError("forbidden", "private"));
    await expect(
      h.service.create(
        { principal: h.alice.principal, sessionId: h.alice.sessionId },
        { parent: "/", name: "New.docx" },
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("WOPI authentication", () => {
  it("checks proofs before storage and ignores forged Host", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    expect((await h.callback(opened)).status).toBe(200);
    const stat = vi.spyOn(h.storage, "statFile");
    const result = await h.callback(opened, { headers: { "X-WOPI-Proof": "AAAA" } });
    expect(result.status).toBe(500);
    expect(stat).not.toHaveBeenCalled();
    expect((await h.callback(opened, { headers: { "X-WOPI-TimeStamp": "bad" } })).status).toBe(500);
  });
  it("refreshes unknown proof keys once and handles rotation", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    const next = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const refresh = vi
      .spyOn(h.cache, "refresh")
      .mockImplementation(async () => ({ ...h.discovery, proofKeys: { current: proofKey(next) } }));
    expect((await h.callback(opened, { pair: next })).status).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("rejects token/file mismatch, revocation and duplicate token params", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    const token = opened.formFields.access_token ?? "";
    expect((await h.app.request(h.signedRequest(randomUUID(), token))).status).toBe(401);
    expect((await h.callback(opened, { urlSuffix: "&access_token=other" })).status).toBe(401);
    expect((await h.app.request("/wopi/files/not-an-id")).status).toBe(401);
    expect((await h.app.request(h.signedRequest(opened.fileId, "bad"))).status).toBe(401);
    await h.repos.sessions.delete(h.alice.session.idHash);
    expect((await h.callback(opened)).status).toBe(401);
  });
  it("rechecks account, identity and provider on every callback", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    const get = vi.spyOn(h.repos.identities, "get");
    get.mockResolvedValueOnce({ ...h.alice.identity, accountId: h.bob.account.id });
    expect((await h.callback(opened)).status).toBe(401);
    get.mockResolvedValueOnce(null);
    expect((await h.callback(opened)).status).toBe(401);
    get.mockResolvedValueOnce({ ...h.alice.identity, providerId: randomUUID() });
    expect((await h.callback(opened)).status).toBe(401);
    vi.spyOn(h.repos.accounts, "get").mockResolvedValueOnce(null);
    expect((await h.callback(opened)).status).toBe(401);
  });
  it("rejects expired, removed, foreign-provider and newly out-of-scope records", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    h.now.value = new Date(h.clock().getTime() + 8 * 3600000);
    expect((await h.callback(opened)).status).toBe(401);
    h.now.value = new Date("2026-09-06T00:00:00Z");
    const get = vi.spyOn(h.files, "get");
    get.mockResolvedValueOnce(null);
    expect((await h.callback(opened)).status).toBe(404);
    const file = await h.files.get(opened.fileId);
    if (!file) throw new Error("missing");
    get.mockResolvedValueOnce({ ...file, providerId: randomUUID() });
    expect((await h.callback(opened)).status).toBe(404);
    get.mockResolvedValueOnce({ ...file, path: "other/a.docx" });
    expect((await h.callback(opened)).status).toBe(404);
  });
  it("rejects browser-session account mismatch and changed connection", async () => {
    const h = await officeHarness();
    await expect(
      h.service.open(
        { principal: h.bob.principal, sessionId: h.alice.sessionId },
        { path: "/a.docx", mode: "edit" },
      ),
    ).rejects.toMatchObject({ status: 401 });
    const service = createOfficeService({ ...h.deps, location: async () => null });
    await expect(
      service.open(
        { principal: h.alice.principal, sessionId: h.alice.sessionId },
        { path: "/a.docx", mode: "edit" },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("rejects read authorization failure without leaking upstream detail", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    vi.spyOn(h.storage, "statFile").mockRejectedValue(
      new StorageError("forbidden", "http://private secret"),
    );
    const response = await h.callback(opened);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });
});

describe("WOPI reads", () => {
  it("returns required CheckFileInfo and streams content, including while locked", async () => {
    const h = await officeHarness();
    const opened = await h.open("/a.docx", "view");
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "writer",
      now: h.clock(),
    });
    const info = (await (await h.callback(opened)).json()) as { LastModifiedTime?: string };
    expect(info).toMatchObject({
      BaseFileName: "a.docx",
      Size: 5,
      UserCanWrite: false,
      ReadOnly: true,
      UserCanNotWriteRelative: true,
      OwnerId: h.provider.id,
      UserId: h.alice.identity.id,
    });
    const content = await h.callback(opened, { contents: true });
    expect(await content.text()).toBe("hello");
    expect(content.headers.get("Content-Length")).toBe("5");
  });
  it.each([
    ["4", 412],
    ["-1", 400],
    ["bad", 400],
    ["9007199254740992", 400],
    ["5", 200],
  ])("enforces MaxExpectedSize %s", async (value, status) => {
    const h = await officeHarness();
    const opened = await h.open();
    expect(
      (
        await h.callback(opened, {
          contents: true,
          headers: { "X-WOPI-MaxExpectedSize": String(value) },
        })
      ).status,
    ).toBe(status);
  });
  it("enforces configured max and detects a larger actual download", async () => {
    const h = await officeHarness({ config: { maxBytes: 5 } });
    const opened = await h.open();
    await h.storage.upload("/a.docx", Buffer.from("longer"));
    expect((await h.callback(opened, { contents: true })).status).toBe(413);
    vi.spyOn(h.storage, "statFile").mockResolvedValue({
      size: 5,
      modifiedAt: null,
      contentType: null,
    });
    expect(
      (await h.callback(opened, { contents: true, headers: { "X-WOPI-MaxExpectedSize": "5" } }))
        .status,
    ).toBe(412);
    expect((await h.callback(opened, { contents: true })).status).toBe(413);
  });
  it("handles absent content metadata and errors inside async GET", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    const original = h.storage.download.bind(h.storage);
    vi.spyOn(h.storage, "download").mockImplementation(async (...args) => ({
      ...(await original(...args)),
      contentLength: null,
      lastModified: null,
      contentType: "text/plain",
    }));
    const content = await h.callback(opened, { contents: true });
    expect(content.headers.get("Content-Type")).toBe("text/plain");
    expect(await content.text()).toBe("hello");
    const info = (await (await h.callback(opened)).json()) as { LastModifiedTime?: string };
    expect(info.LastModifiedTime).toBeUndefined();
    vi.spyOn(h.storage, "download").mockRejectedValue(new Error("private"));
    expect((await h.callback(opened)).status).toBe(500);
  });
  it("returns 501 for unsupported methods", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    expect((await h.callback(opened, { method: "DELETE" })).status).toBe(501);
  });
});

it("supports an old-proof-only rotation and rejects absent timestamp", async () => {
  const h = await officeHarness();
  const opened = await h.open();
  const request = h.signedRequest(opened.fileId, opened.formFields.access_token ?? "");
  const old = request.headers.get("X-WOPI-Proof") ?? "";
  request.headers.delete("X-WOPI-Proof");
  request.headers.set("X-WOPI-ProofOld", old);
  expect((await h.app.request(request)).status).toBe(200);
  const noTimestamp = h.signedRequest(opened.fileId, opened.formFields.access_token ?? "");
  noTimestamp.headers.delete("X-WOPI-TimeStamp");
  expect((await h.app.request(noTimestamp)).status).toBe(500);
});
it("revalidates session expiry and principal account even with permissive repositories", async () => {
  const h = await officeHarness();
  const opened = await h.open();
  const sessions = vi
    .spyOn(h.repos.sessions, "getByIdHash")
    .mockResolvedValueOnce({ ...h.alice.session, expiresAt: h.clock() });
  expect((await h.callback(opened)).status).toBe(401);
  sessions.mockRestore();
  await expect(
    h.service.open(
      {
        principal: { ...h.alice.principal, accountId: h.bob.account.id },
        sessionId: h.alice.sessionId,
      },
      { path: "/a.docx", mode: "edit" },
    ),
  ).rejects.toMatchObject({ status: 401 });
});

it("returns router-compatible folder and explicit edit links from view mode", async () => {
  const h = await officeHarness();
  await h.storage.mkdir("/folder å");
  await h.storage.upload("/folder å/a.docx", new TextEncoder().encode("hello"));
  const opened = await h.open("/folder å/a.docx", "view");
  const info = (await (await h.callback(opened)).json()) as Record<string, unknown>;
  expect(info.CloseUrl).toBe(`${h.config.appUrl}/files/folder%20%C3%A5`);
  expect(info.HostViewUrl).toContain("?mode=view");
  expect(info.HostEditUrl).toContain("?mode=edit");
  vi.spyOn(h.repos.sessions, "getByIdHash").mockResolvedValue({
    ...h.alice.session,
    activeIdentityId: h.bob.identity.id,
  });
  const nonactive = (await (await h.callback(opened)).json()) as Record<string, unknown>;
  expect(nonactive.CloseUrl).toBe(`${h.config.appUrl}/files`);
});
