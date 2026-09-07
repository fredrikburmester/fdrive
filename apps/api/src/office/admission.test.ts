import { expect, it, vi } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";
import { browserActor, canEditOfficeFile, requireOfficeEdit } from "./auth.ts";

it("fails closed without admission, on errors, and for noncanonical paths", async () => {
  const h = await officeHarness({ deps: { canEdit: undefined } });
  await expect(h.open()).rejects.toMatchObject({ status: 403 });
  const view = await h.open("/a.docx", "view");
  expect(await (await h.callback(view)).json()).toMatchObject({
    UserCanWrite: false,
    ReadOnly: true,
  });
  const actor = await browserActor(h.deps, {
    principal: h.alice.principal,
    sessionId: h.alice.sessionId,
  });
  expect(await canEditOfficeFile(h.deps, actor, "/a.docx")).toBe(false);
  await expect(requireOfficeEdit(h.deps, actor, "/a.docx")).rejects.toMatchObject({ status: 403 });
  const denied = vi.fn(async () => {
    throw new Error("private policy error");
  });
  expect(await canEditOfficeFile({ ...h.deps, canEdit: denied }, actor, "/a.docx")).toBe(false);
  denied.mockClear();
  expect(await canEditOfficeFile({ ...h.deps, canEdit: denied }, actor, "/a/../b")).toBe(false);
  expect(denied).not.toHaveBeenCalled();
});

it.each(["edit", "convert"] as const)(
  "denies browser %s before discovery, registry or token minting",
  async (mode) => {
    const h = await officeHarness();
    const discovery = vi.spyOn(h.cache, "get");
    const ensure = vi.spyOn(h.files, "ensure");
    const path = mode === "convert" ? "/legacy.doc" : "/a.docx";
    await expect(h.open(path, mode, h.reader)).rejects.toMatchObject({ status: 403 });
    expect(discovery).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    const view = await h.open("/a.docx", "view", h.reader);
    const info = await (await h.callback(view)).json();
    expect(info).toMatchObject({
      UserCanWrite: false,
      UserCanRename: false,
      ReadOnly: true,
      UserCanNotWriteRelative: true,
    });
    expect(info).not.toHaveProperty("HostEditUrl");
    expect(await (await h.callback(view, { contents: true })).text()).toBe("hello");
  },
);

it("denies creation before storage and checks admission again after obtaining the write scope", async () => {
  const h = await officeHarness();
  const upload = vi.spyOn(h.storage, "upload");
  const create = (user = h.reader) =>
    h.service.create(
      { principal: user.principal, sessionId: user.sessionId },
      { parent: "/", name: "new.docx" },
    );
  await expect(create()).rejects.toMatchObject({ status: 403 });
  const admission = vi
    .fn(async () => true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  Object.assign(h.deps, { canEdit: admission });
  await expect(create(h.alice)).rejects.toMatchObject({ status: 403 });
  expect(upload).not.toHaveBeenCalled();
});

it("revokes existing edit tokens, preserving reads and the writer lock", async () => {
  let allowed = true;
  const h = await officeHarness({ deps: { canEdit: async () => allowed } });
  const opened = await h.open();
  await h.locks.apply({
    fileId: opened.fileId,
    operation: "lock",
    lockId: "writer",
    now: h.clock(),
  });
  allowed = false;
  const info = await (await h.callback(opened)).json();
  expect(info).toMatchObject({ UserCanWrite: false, ReadOnly: true });
  expect(info).not.toHaveProperty("HostEditUrl");
  for (const override of [
    "PUT",
    "PUT_RELATIVE",
    "RENAME_FILE",
    "UNLOCK",
    "REFRESH_LOCK",
    "UNLOCK_AND_RELOCK",
  ]) {
    const result = await h.callback(opened, {
      method: "POST",
      contents: override === "PUT",
      headers: {
        "X-WOPI-Override": override,
        "X-WOPI-Lock": "writer",
        "X-WOPI-OldLock": "writer",
        "X-WOPI-RelativeTarget": "copy.docx",
        "X-WOPI-RequestedName": "renamed",
      },
      body: "denied",
    });
    expect(result.status, override).toBe(403);
  }
  expect(
    (
      await h.callback(opened, {
        method: "POST",
        headers: { "X-WOPI-Override": "LOCK", "X-WOPI-Lock": "reader" },
      })
    ).status,
  ).toBe(200);
  expect(await h.locks.get(opened.fileId, h.clock())).toBe("writer");
  expect(await (await h.callback(opened, { contents: true })).text()).toBe("hello");
});

it.each(["PUT_RELATIVE", "RENAME_FILE"])(
  "requires independent destination admission for %s",
  async (override) => {
    const h = await officeHarness({ deps: { canEdit: async (_, path) => path === "/a.docx" } });
    const opened = await h.open();
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "writer",
      now: h.clock(),
    });
    const upload = vi.spyOn(h.storage, "upload");
    const move = vi.spyOn(h.storage, "move");
    const response = await h.callback(opened, {
      method: "POST",
      headers: {
        "X-WOPI-Override": override,
        "X-WOPI-Lock": "writer",
        "X-WOPI-RelativeTarget": "copy.docx",
        "X-WOPI-RequestedName": "renamed",
      },
      body: "denied",
    });
    expect(response.status).toBe(403);
    expect(upload).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(await (await h.callback(opened, { contents: true })).text()).toBe("hello");
  },
);

it.each(["PUT", "PUT_RELATIVE"])(
  "rechecks source admission after staging %s bytes",
  async (override) => {
    let allowed = true;
    const h = await officeHarness({ deps: { canEdit: async () => allowed } });
    const opened = await h.open();
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "writer",
      now: h.clock(),
    });
    const upload = vi.spyOn(h.storage, "upload");
    let release: (() => void) | undefined;
    const staged = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await staged;
        controller.enqueue(new TextEncoder().encode("denied"));
        controller.close();
      },
    });
    const stat = vi.spyOn(h.storage, "statFile");
    const response = h.callback(opened, {
      method: "POST",
      contents: override === "PUT",
      headers: {
        "X-WOPI-Override": override,
        "X-WOPI-Lock": "writer",
        "X-WOPI-RelativeTarget": "copy.docx",
      },
      body,
    });
    await vi.waitFor(() => expect(stat.mock.calls.length).toBeGreaterThan(1));
    allowed = false;
    release?.();
    expect((await response).status).toBe(403);
    expect(upload).not.toHaveBeenCalled();
  },
);
