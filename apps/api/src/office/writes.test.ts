import { StorageError } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";

describe("WOPI locks", () => {
  it("locks, conflicts, refreshes, reads, relocks and unlocks across users", async () => {
    const h = await officeHarness();
    const a = await h.open();
    const b = await h.open("/a.docx", "edit", h.bob);
    const post = (o: typeof a, op: string, lock?: string, old?: string) =>
      h.callback(o, {
        method: "POST",
        headers: {
          "X-WOPI-Override": op,
          ...(lock === undefined ? {} : { "X-WOPI-Lock": lock }),
          ...(old === undefined ? {} : { "X-WOPI-OldLock": old }),
        },
      });
    expect((await post(a, "LOCK", "one")).status).toBe(200);
    const conflict = await post(b, "LOCK", "two");
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("X-WOPI-Lock")).toBe("one");
    expect((await post(b, "REFRESH_LOCK", "one")).status).toBe(200);
    expect((await post(a, "GET_LOCK")).headers.get("X-WOPI-Lock")).toBe("one");
    expect((await post(a, "LOCK", "two", "one")).status).toBe(200);
    expect((await post(b, "UNLOCK_AND_RELOCK", "three", "two")).status).toBe(200);
    expect((await post(b, "UNLOCK", "three")).status).toBe(200);
    expect((await post(a, "GET_LOCK")).headers.get("X-WOPI-Lock")).toBe("");
    const absent = await post(a, "UNLOCK", "three");
    expect(absent.status).toBe(409);
    expect(absent.headers.get("X-WOPI-Lock")).toBe("");
  });
  it("acknowledges readonly LOCK without disturbing another editor", async () => {
    const h = await officeHarness();
    const view = await h.open("/a.docx", "view", h.reader);
    await h.locks.apply({
      fileId: view.fileId,
      operation: "lock",
      lockId: "writer",
      now: h.clock(),
    });
    const response = await h.callback(view, {
      method: "POST",
      headers: { "X-WOPI-Override": "LOCK", "X-WOPI-Lock": "viewer" },
    });
    expect(response.status).toBe(200);
    expect(await h.locks.get(view.fileId, h.clock())).toBe("writer");
    expect(
      (
        await h.callback(view, {
          method: "POST",
          headers: { "X-WOPI-Override": "UNLOCK", "X-WOPI-Lock": "writer" },
        })
      ).status,
    ).toBe(403);
  });
  it.each([
    {},
    { "X-WOPI-Override": "LOCK" },
    { "X-WOPI-Override": "LOCK", "X-WOPI-Lock": "" },
    { "X-WOPI-Override": "UNLOCK_AND_RELOCK", "X-WOPI-Lock": "next" },
  ])("rejects missing lock headers", async (headers) => {
    const h = await officeHarness();
    expect((await h.callback(await h.open(), { method: "POST", headers })).status).toBe(400);
  });
  it("rejects unsupported overrides on either endpoint", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    expect(
      (await h.callback(opened, { method: "POST", headers: { "X-WOPI-Override": "DELETE" } }))
        .status,
    ).toBe(501);
    expect(
      (
        await h.callback(opened, {
          method: "POST",
          contents: true,
          headers: { "X-WOPI-Override": "LOCK" },
        })
      ).status,
    ).toBe(501);
  });
});

describe("PutFile", () => {
  it("requires matching lock on nonempty content and publishes version after save", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    const headers = { "X-WOPI-Override": "PUT" };
    const absent = await h.callback(opened, {
      contents: true,
      method: "POST",
      headers,
      body: "new",
    });
    expect(absent.status).toBe(409);
    expect(absent.headers.get("X-WOPI-Lock")).toBe("");
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "edit",
      now: h.clock(),
    });
    const bad = await h.callback(opened, {
      contents: true,
      method: "POST",
      headers: { ...headers, "X-WOPI-Lock": "wrong" },
      body: "new",
    });
    expect(bad.status).toBe(409);
    const response = await h.callback(opened, {
      contents: true,
      method: "POST",
      headers: { ...headers, "X-WOPI-Lock": "edit" },
      body: "new",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-WOPI-ItemVersion")).toBeTruthy();
    expect(await new Response((await h.storage.download("/a.docx")).body).text()).toBe("new");
    expect(h.events.at(-1)).toMatchObject({ op: "update", paths: ["/a.docx"] });
  });
  it("allows an empty unlocked target but forbids view writes", async () => {
    const h = await officeHarness();
    const edit = await h.open("/empty.docx");
    expect(
      (
        await h.callback(edit, {
          contents: true,
          method: "POST",
          headers: { "X-WOPI-Override": "PUT" },
          body: "first",
        })
      ).status,
    ).toBe(200);
    const view = await h.open("/empty.docx", "view");
    expect(
      (
        await h.callback(view, {
          contents: true,
          method: "POST",
          headers: { "X-WOPI-Override": "PUT" },
          body: "bad",
        })
      ).status,
    ).toBe(403);
  });
  it.each([
    ["bad", 400],
    ["-1", 400],
    ["9007199254740992", 400],
    ["6", 413],
    ["2", 400],
  ])("rejects Content-Length %s", async (length, status) => {
    const h = await officeHarness({ config: { maxBytes: 5 } });
    const opened = await h.open("/empty.docx");
    expect(
      (
        await h.callback(opened, {
          contents: true,
          method: "POST",
          headers: { "X-WOPI-Override": "PUT", "Content-Length": String(length) },
          body: "x",
        })
      ).status,
    ).toBe(status);
  });
  it("bounds unknown-length uploads and accepts an empty request body", async () => {
    const h = await officeHarness({ config: { maxBytes: 5 } });
    const opened = await h.open("/empty.docx");
    expect(
      (
        await h.callback(opened, {
          contents: true,
          method: "POST",
          headers: { "X-WOPI-Override": "PUT" },
          body: "too long",
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await h.callback(opened, {
          contents: true,
          method: "POST",
          headers: { "X-WOPI-Override": "PUT", "Content-Length": "0" },
        })
      ).status,
    ).toBe(200);
  });
  it("never claims success when upload or readback fails", async () => {
    const h = await officeHarness();
    const opened = await h.open("/empty.docx");
    const upload = vi
      .spyOn(h.storage, "upload")
      .mockRejectedValueOnce(new StorageError("forbidden", "private"));
    expect(
      (
        await h.callback(opened, {
          contents: true,
          method: "POST",
          headers: { "X-WOPI-Override": "PUT" },
          body: "new",
        })
      ).status,
    ).toBe(403);
    upload.mockRestore();
    vi.spyOn(h.storage, "download").mockRejectedValueOnce(new Error("readback"));
    expect(
      (
        await h.callback(opened, {
          contents: true,
          method: "POST",
          headers: { "X-WOPI-Override": "PUT" },
          body: "new",
        })
      ).status,
    ).toBe(500);
    expect(h.events).toHaveLength(0);
  });
});

describe("PutRelative", () => {
  it("Save As works without source lock header while the source is locked", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "writer",
      now: h.clock(),
    });
    const result = await h.callback(opened, {
      method: "POST",
      headers: {
        "X-WOPI-Override": "PUT_RELATIVE",
        "X-WOPI-SuggestedTarget": ".docx",
        "X-WOPI-FileConversion": "true",
      },
      body: "converted",
    });
    expect(result.status).toBe(200);
    const json = (await result.json()) as { Name: string; HostEditUrl: string; Url: string };
    expect(json.Name).toBe("a (1).docx");
    expect(json.HostEditUrl).toContain(encodeURIComponent(h.alice.identity.id));
    const target = new URL(json.Url);
    const id = target.pathname.split("/").at(-1) ?? "";
    const token = target.searchParams.get("access_token") ?? "";
    expect((await h.app.request(h.signedRequest(id, token))).status).toBe(200);
    expect(await new Response((await h.storage.download("/a.docx")).body).text()).toBe("hello");
  });
  it("sanitizes suggested names and decodes UTF7", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    const result = await h.callback(opened, {
      method: "POST",
      headers: {
        "X-WOPI-Override": "PUT_RELATIVE",
        "X-WOPI-SuggestedTarget": "bad/name+AMU-.docx",
      },
      body: "new",
    });
    expect(((await result.json()) as { Name: string }).Name).toBe("bad_nameÅ.docx");
  });
  it("checks a supplied source lock, honors overwrite, rejects locked targets", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "source",
      now: h.clock(),
    });
    const headers = {
      "X-WOPI-Override": "PUT_RELATIVE",
      "X-WOPI-RelativeTarget": "empty.docx",
      "X-WOPI-Lock": "source",
    };
    expect(
      (
        await h.callback(opened, {
          method: "POST",
          headers: { ...headers, "X-WOPI-Lock": "bad" },
          body: "new",
        })
      ).status,
    ).toBe(409);
    expect((await h.callback(opened, { method: "POST", headers, body: "new" })).status).toBe(409);
    const overwrite = { ...headers, "X-WOPI-OverwriteRelativeTarget": "true" };
    expect(
      (await h.callback(opened, { method: "POST", headers: overwrite, body: "new" })).status,
    ).toBe(200);
    const target = await h.open("/empty.docx");
    await h.locks.apply({
      fileId: target.fileId,
      operation: "lock",
      lockId: "target",
      now: h.clock(),
    });
    const conflict = await h.callback(opened, { method: "POST", headers: overwrite, body: "bad" });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("X-WOPI-Lock")).toBe("target");
  });
  it.each([
    {},
    { "X-WOPI-RelativeTarget": "a.docx", "X-WOPI-SuggestedTarget": "b.docx" },
    { "X-WOPI-RelativeTarget": "../a.docx" },
    { "X-WOPI-RelativeTarget": "+AA-" },
    { "X-WOPI-RelativeTarget": "b.docx", "X-WOPI-OverwriteRelativeTarget": "yes" },
  ])("rejects malformed relative request", async (headers) => {
    const h = await officeHarness();
    expect(
      (
        await h.callback(await h.open(), {
          method: "POST",
          headers: { "X-WOPI-Override": "PUT_RELATIVE", ...headers },
          body: "new",
        })
      ).status,
    ).toBe(400);
  });
  it("rejects view copies and never overwrites suggested target even with overwrite flag", async () => {
    const h = await officeHarness();
    const view = await h.open("/a.docx", "view");
    expect(
      (
        await h.callback(view, {
          method: "POST",
          headers: { "X-WOPI-Override": "PUT_RELATIVE", "X-WOPI-SuggestedTarget": "b.docx" },
          body: "new",
        })
      ).status,
    ).toBe(403);
    const edit = await h.open();
    const result = await h.callback(edit, {
      method: "POST",
      headers: {
        "X-WOPI-Override": "PUT_RELATIVE",
        "X-WOPI-SuggestedTarget": "a.docx",
        "X-WOPI-OverwriteRelativeTarget": "true",
      },
      body: "new",
    });
    expect(((await result.json()) as { Name: string }).Name).toBe("a (1).docx");
  });
});

describe("RenameFile", () => {
  it("preserves UUID, extension, tags and favorites when renaming Unicode", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    const tag = await h.deps.metadata.createTag(h.alice.account.id, { name: "work", color: null });
    await h.deps.metadata.setFileTags(
      { accountId: h.alice.account.id, identityId: h.alice.identity.id },
      "/a.docx",
      [tag.id],
    );
    await h.deps.metadata.addFavorite(h.alice.identity.id, "/a.docx", "file");
    const result = await h.callback(opened, {
      method: "POST",
      headers: { "X-WOPI-Override": "RENAME_FILE", "X-WOPI-RequestedName": "+AMU-rsrapport" },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ Name: "Årsrapport" });
    expect((await h.files.get(opened.fileId))?.path).toBe("shared/Årsrapport.docx");
    expect(await h.deps.metadata.filesForTag(h.alice.identity.id, tag.id)).toEqual([
      "/Årsrapport.docx",
    ]);
    expect((await h.callback(opened)).status).toBe(200);
    expect((await h.open("/Årsrapport.docx")).fileId).toBe(opened.fileId);
    expect(h.events.at(-1)).toMatchObject({ op: "move", targetPaths: ["/Årsrapport.docx"] });
  });
  it("supports same-name no-op and extensionless files", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    expect(
      (
        await h.callback(opened, {
          method: "POST",
          headers: { "X-WOPI-Override": "RENAME_FILE", "X-WOPI-RequestedName": "a" },
        })
      ).status,
    ).toBe(200);
    expect(h.events).toHaveLength(0);
    const plain = await h.open("/plain");
    expect(
      (
        await h.callback(plain, {
          method: "POST",
          headers: { "X-WOPI-Override": "RENAME_FILE", "X-WOPI-RequestedName": "renamed" },
        })
      ).status,
    ).toBe(200);
  });
  it("rejects collisions, unsafe names, absent name and mismatched lock", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    for (const name of ["../evil", "empty", "+AA-", "a".repeat(255)]) {
      const response = await h.callback(opened, {
        method: "POST",
        headers: { "X-WOPI-Override": "RENAME_FILE", "X-WOPI-RequestedName": name },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("X-WOPI-InvalidFileNameError")).toBeTruthy();
    }
    expect(
      (await h.callback(opened, { method: "POST", headers: { "X-WOPI-Override": "RENAME_FILE" } }))
        .status,
    ).toBe(400);
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "lock",
      now: h.clock(),
    });
    expect(
      (
        await h.callback(opened, {
          method: "POST",
          headers: { "X-WOPI-Override": "RENAME_FILE", "X-WOPI-RequestedName": "new" },
        })
      ).status,
    ).toBe(409);
  });
});

describe("save-copy collision races", () => {
  it.each([true, false])("rechecks suggested=%s immediately before upload", async (suggested) => {
    const h = await officeHarness();
    const opened = await h.open();
    const original = h.storage.statFile.bind(h.storage);
    let calls = 0;
    vi.spyOn(h.storage, "statFile").mockImplementation(async (path) => {
      if (path === "/race.docx") {
        calls++;
        if (calls === 1) throw new StorageError("not_found", "missing");
        return { size: 1, modifiedAt: null, contentType: null };
      }
      return original(path);
    });
    const response = await h.callback(opened, {
      method: "POST",
      headers: {
        "X-WOPI-Override": "PUT_RELATIVE",
        [suggested ? "X-WOPI-SuggestedTarget" : "X-WOPI-RelativeTarget"]: "race.docx",
      },
      body: "new",
    });
    expect(response.status).toBe(suggested ? 200 : 409);
    if (suggested)
      expect((await response.json()) as unknown).toMatchObject({ Name: "race (1).docx" });
  });
  it("bounds repeated suggested-name collisions", async () => {
    const h = await officeHarness();
    const opened = await h.open();
    vi.spyOn(h.storage, "statFile").mockResolvedValue({
      size: 1,
      modifiedAt: null,
      contentType: null,
    });
    const response = await h.callback(opened, {
      method: "POST",
      headers: { "X-WOPI-Override": "PUT_RELATIVE", "X-WOPI-SuggestedTarget": "collision.docx" },
      body: "new",
    });
    expect(response.status).toBe(500);
  });
});
it("retains extension case during rename", async () => {
  const h = await officeHarness();
  await h.storage.upload("/Report.DOCX", Buffer.from("hello"));
  const opened = await h.open("/Report.DOCX");
  expect(
    (
      await h.callback(opened, {
        method: "POST",
        headers: { "X-WOPI-Override": "RENAME_FILE", "X-WOPI-RequestedName": "Renamed" },
      })
    ).status,
  ).toBe(200);
  expect((await h.files.get(opened.fileId))?.path).toBe("shared/Renamed.DOCX");
});

it("rejects a chunked oversized save before the upstream file is touched", async () => {
  const h = await officeHarness({ config: { maxBytes: 5 } });
  const opened = await h.open();
  await h.locks.apply({
    fileId: opened.fileId,
    operation: "lock",
    lockId: "writer",
    now: h.clock(),
  });
  const upload = vi.spyOn(h.storage, "upload");
  const response = await h.callback(opened, {
    contents: true,
    method: "POST",
    headers: { "X-WOPI-Override": "PUT", "X-WOPI-Lock": "writer" },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("12345"));
        c.enqueue(new TextEncoder().encode("6"));
        c.close();
      },
    }),
  });
  expect(response.status).toBe(413);
  expect(upload).not.toHaveBeenCalled();
  expect(await new Response((await h.storage.download("/a.docx")).body).text()).toBe("hello");
});

it("keeps scoped writes on scoped repositories and runs metadata only after commit", async () => {
  const h = await officeHarness();
  const scopedFiles = { ...h.files };
  const scopedLocks = { ...h.locks };
  let inScope = false;
  vi.spyOn(h.deps, "withWriteScope").mockImplementation(async (_providerId, callback) => {
    inScope = true;
    try {
      return await callback({ files: scopedFiles, locks: scopedLocks });
    } finally {
      inScope = false;
    }
  });
  vi.spyOn(h.files, "ensure").mockImplementation(async (input) => {
    expect(inScope).toBe(false);
    return scopedFiles.ensure(input);
  });
  vi.spyOn(h.files, "movePrefix").mockImplementation(async (input) => {
    expect(inScope).toBe(false);
    return scopedFiles.movePrefix(input);
  });
  vi.spyOn(h.locks, "withFileLock").mockImplementation(async (id, callback) => {
    expect(inScope).toBe(false);
    return scopedLocks.withFileLock(id, callback);
  });
  const metadata = vi.spyOn(h.deps.metadata, "onMoved").mockImplementation(async () => {
    expect(inScope).toBe(false);
  });
  await h.service.create(
    { principal: h.alice.principal, sessionId: h.alice.sessionId },
    { parent: "/", name: "new.docx" },
  );
  const opened = await h.open("/empty.docx");
  expect(
    (
      await h.callback(opened, {
        method: "POST",
        contents: true,
        headers: { "X-WOPI-Override": "PUT" },
        body: "saved",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.callback(opened, {
        method: "POST",
        headers: { "X-WOPI-Override": "PUT_RELATIVE", "X-WOPI-RelativeTarget": "copy.docx" },
        body: "copy",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.callback(opened, {
        method: "POST",
        headers: { "X-WOPI-Override": "RENAME_FILE", "X-WOPI-RequestedName": "renamed" },
      })
    ).status,
  ).toBe(200);
  expect(metadata).toHaveBeenCalledOnce();
});

it("saves a queued PUT to the current registry path after an earlier rename", async () => {
  const h = await officeHarness();
  const opened = await h.open();
  await h.locks.apply({ fileId: opened.fileId, operation: "lock", lockId: "edit", now: h.clock() });
  const entered = writeBarrier();
  const queued = writeBarrier();
  const release = writeBarrier();
  const withWriteScope = h.deps.withWriteScope;
  let calls = 0;
  vi.spyOn(h.deps, "withWriteScope").mockImplementation(async (provider, callback) => {
    const first = calls++ === 0;
    if (!first) queued.resolve();
    return withWriteScope(provider, async (scope) => {
      if (first) {
        entered.resolve();
        await release.promise;
      }
      return callback(scope);
    });
  });
  const renamed = h.callback(opened, {
    method: "POST",
    headers: {
      "X-WOPI-Override": "RENAME_FILE",
      "X-WOPI-RequestedName": "renamed",
      "X-WOPI-Lock": "edit",
    },
  });
  await entered.promise;
  const saved = h.callback(opened, {
    method: "POST",
    contents: true,
    body: "queued edit",
    headers: { "X-WOPI-Override": "PUT", "X-WOPI-Lock": "edit" },
  });
  await queued.promise;
  release.resolve();
  expect((await renamed).status).toBe(200);
  expect((await saved).status).toBe(200);
  expect(await new Response((await h.storage.download("/renamed.docx")).body).text()).toBe(
    "queued edit",
  );
  await expect(h.storage.statFile("/a.docx")).rejects.toThrow();
  expect((await h.files.get(opened.fileId))?.path).toBe("shared/renamed.docx");
});

it("denies a PUT queued behind deletion without recreating its old path", async () => {
  const h = await officeHarness();
  const opened = await h.open();
  const entered = writeBarrier();
  const release = writeBarrier();
  const queued = writeBarrier();
  const withWriteScope = h.deps.withWriteScope;
  const deletion = withWriteScope(h.provider.id, async (scope) => {
    entered.resolve();
    await release.promise;
    await h.storage.deleteFile("/a.docx");
    await scope.files.deletePrefix({
      providerId: h.provider.id,
      rootName: "sftpgo",
      path: "shared/a.docx",
      at: h.clock(),
    });
  });
  await entered.promise;
  vi.spyOn(h.deps, "withWriteScope").mockImplementation((provider, callback) => {
    queued.resolve();
    return withWriteScope(provider, callback);
  });
  const saved = h.callback(opened, {
    method: "POST",
    contents: true,
    body: "queued",
    headers: { "X-WOPI-Override": "PUT" },
  });
  await queued.promise;
  release.resolve();
  await deletion;
  expect((await saved).status).toBe(404);
  await expect(h.storage.statFile("/a.docx")).rejects.toThrow();
  expect(await h.files.get(opened.fileId)).toBeNull();
});

it.each(["RENAME_FILE", "PUT_RELATIVE"])(
  "uses the current source directory for queued %s",
  async (override) => {
    const h = await officeHarness();
    const opened = await h.open();
    await h.locks.apply({
      fileId: opened.fileId,
      operation: "lock",
      lockId: "edit",
      now: h.clock(),
    });
    const withWriteScope = h.deps.withWriteScope;
    vi.spyOn(h.deps, "withWriteScope").mockImplementation((provider, callback) =>
      withWriteScope(provider, async (scope) => {
        await h.storage.move("/a.docx", "/folder/current.DOCX");
        await scope.files.movePrefix({
          providerId: h.provider.id,
          rootName: "sftpgo",
          from: "shared/a.docx",
          to: "shared/folder/current.DOCX",
          at: h.clock(),
        });
        return callback(scope);
      }),
    );
    const response = await h.callback(opened, {
      method: "POST",
      headers: {
        "X-WOPI-Override": override,
        "X-WOPI-Lock": "edit",
        "X-WOPI-RequestedName": "final",
        "X-WOPI-RelativeTarget": "copy.docx",
      },
      body: "copied",
    });
    expect(response.status).toBe(200);
    const target = override === "RENAME_FILE" ? "/folder/final.DOCX" : "/folder/copy.docx";
    expect(await new Response((await h.storage.download(target)).body).text()).toBe(
      override === "RENAME_FILE" ? "hello" : "copied",
    );
    await expect(h.storage.statFile("/a.docx")).rejects.toThrow();
    if (override === "RENAME_FILE") {
      expect((await h.files.get(opened.fileId))?.path).toBe("shared/folder/final.DOCX");
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: "fs",
          paths: ["/folder/current.DOCX"],
          targetPaths: [target],
        }),
      );
    } else {
      expect(await response.json()).toMatchObject({
        Name: "copy.docx",
        HostViewUrl: expect.stringContaining("/folder/copy.docx?mode=view"),
      });
      expect((await h.files.get(opened.fileId))?.path).toBe("shared/folder/current.DOCX");
    }
  },
);

function writeBarrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}
