import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopWriteEntry } from "@fdrive/contracts";
import { StorageError, type StorageProvider } from "@fdrive/core";
import type { DesktopEffectContext } from "@fdrive/db";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { memoryRepo } from "../../test/helpers/desktop-repo.js";
import type { Principal } from "../auth/principal.js";
import { createDesktopWrites, DESKTOP_TRASH, NO_WRITES } from "./writes.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Missing fixture value");
  return value;
}
const body = (value: string) => required(new Response(value).body);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), "desktop-unit-"));
  temporary.push(stateDir);
  const memory = memoryRepo();
  const raw = createMemoryStorage({ "/old.txt": "old", "/folder/child": "child" });
  const storage: StorageProvider = { ...raw, withWriteLease: vi.fn(async (action) => action(raw)) };
  const principal: Principal = {
    accountId: randomUUID(),
    identityId: randomUUID(),
    username: "test",
    isAdmin: false,
    storage,
    tokenAccess: { mode: "full", paths: ["/"] },
    verifyAuthority: vi.fn(async () => true),
  };
  const effectContext = vi.fn(
    async (_principal: Principal, context: Omit<DesktopEffectContext, "office">) => ({
      ...context,
      office: null,
    }),
  );
  const deps = {
    repo: memory.repo,
    stateDir,
    clock: () => new Date(),
    trashPathForStorage: () => null,
    effectContext,
  };
  const service = createDesktopWrites(deps);
  const stage = async (name: string, bytes: string, existing?: DesktopWriteEntry) => {
    const request = {
      kind: "upload" as const,
      operationId: randomUUID(),
      parentId: "root",
      name,
      base: existing ? { ...existing.version, content: sha("old") } : null,
      ...(existing ? { itemId: existing.id } : {}),
      size: Buffer.byteLength(bytes),
      sha256: sha(bytes),
    };
    await service.prepare(principal, request);
    await service.upload(principal, request.operationId, body(bytes), new AbortController().signal);
    return request;
  };
  const read = async (path: string) => new Response((await raw.download(path)).body).text();
  return {
    ...memory,
    raw,
    storage,
    principal,
    service,
    deps,
    stateDir,
    stage,
    read,
    effectContext,
  };
}

it("retains a durable upload receipt and never republishes after acknowledgement/restart", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const request = await f.stage("old.txt", "saved", original);
  expect(await f.read("/old.txt")).toBe("old");
  const ready = await f.service.status(f.principal, request.operationId);
  expect(ready.state).toBe("ready");
  const op = required(
    await f.repo.operation(f.principal.identityId, f.principal.accountId, request.operationId),
  );
  expect(
    await readFile(
      join(
        f.stateDir,
        f.principal.identityId,
        request.operationId,
        required(op.result).uploadFile as string,
      ),
      "utf8",
    ),
  ).toBe("saved");
  const result = await f.service.commit(f.principal, request.operationId);
  expect(result.item?.id).toBe(original.id);
  expect(result.item?.version.content).toBe(sha("saved"));
  expect(await f.read("/old.txt")).toBe("saved");
  expect(f.effectContext).toHaveBeenCalledWith(f.principal, {
    from: "/old.txt",
    to: "/old.txt",
    directory: false,
    trash: false,
  });
  const restarted = createDesktopWrites(f.deps);
  expect(await restarted.commit(f.principal, request.operationId)).toEqual(result);
  await restarted.acknowledge(f.principal, request.operationId);
  expect(await restarted.status(f.principal, request.operationId)).toEqual(result);
  expect(
    await restarted.upload(
      f.principal,
      request.operationId,
      body("ignored"),
      new AbortController().signal,
    ),
  ).toEqual(result);
  expect(await restarted.prepare(f.principal, request)).toEqual(result);
  await expect(
    restarted.prepare(f.principal, { ...request, name: "different" }),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(f.storage.withWriteLease).toHaveBeenCalledTimes(1);
});

it("creates zero-byte files and folders, moves descendants and preserves identities", async () => {
  const f = await fixture();
  const zero = await f.stage("empty", "");
  await f.service.commit(f.principal, zero.operationId);
  expect(await f.read("/empty")).toBe("");
  const folder = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "created",
  };
  expect((await f.service.prepare(f.principal, folder)).state).toBe("ready");
  const created = required((await f.service.commit(f.principal, folder.operationId)).item);
  const source = await f.service.stat(f.principal, "/folder");
  const child = await f.service.stat(f.principal, "/folder/child");
  const move = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: source.id,
    parentId: created.id,
    name: "moved",
    base: source.version,
  };
  await f.service.prepare(f.principal, move);
  const moved = required((await f.service.commit(f.principal, move.operationId)).item);
  expect(moved.id).toBe(source.id);
  expect((await f.service.stat(f.principal, "/created/moved/child")).id).toBe(child.id);
  const noop = { ...move, operationId: randomUUID(), base: moved.version };
  await f.service.prepare(f.principal, noop);
  expect((await f.service.commit(f.principal, noop.operationId)).item?.id).toBe(source.id);
});

it("rejects stale content, occupied/case-folded names, root and escaping scope mutations", async () => {
  const f = await fixture();
  const source = await f.service.stat(f.principal, "/old.txt");
  const stale = await f.stage("old.txt", "local", source);
  await f.raw.upload("/old.txt", new TextEncoder().encode("new"));
  await expect(f.service.commit(f.principal, stale.operationId)).rejects.toMatchObject({
    details: { code: "version_conflict" },
  });
  expect(await f.read("/old.txt")).toBe("new");
  const collision = await f.stage("OLD.TXT", "local");
  await expect(f.service.commit(f.principal, collision.operationId)).rejects.toMatchObject({
    details: { code: "name_collision" },
  });
  const denied = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: ".fdrive-desktop",
  };
  await f.service.prepare(f.principal, denied);
  await expect(f.service.commit(f.principal, denied.operationId)).rejects.toMatchObject({
    kind: "forbidden",
  });
  const root = await f.service.stat(f.principal, "/");
  const moveRoot = {
    kind: "move" as const,
    operationId: randomUUID(),
    parentId: "root",
    itemId: "root",
    name: "renamed",
    base: root.version,
  };
  await f.service.prepare(f.principal, moveRoot);
  await expect(f.service.commit(f.principal, moveRoot.operationId)).rejects.toMatchObject({
    kind: "forbidden",
  });
  const scoped = {
    ...f.principal,
    tokenAccess: { mode: "full" as const, paths: ["/folder/child"] },
  };
  const create = { ...denied, operationId: randomUUID(), name: "outside" };
  await f.service.prepare(scoped, create);
  await expect(f.service.commit(scoped, create.operationId)).rejects.toMatchObject({
    kind: "forbidden",
  });
  const folder = await f.service.stat(f.principal, "/folder");
  const intoSelf = {
    ...moveRoot,
    operationId: randomUUID(),
    parentId: folder.id,
    itemId: folder.id,
    base: folder.version,
  };
  await f.service.prepare(f.principal, intoSelf);
  await expect(f.service.commit(f.principal, intoSelf.operationId)).rejects.toMatchObject({
    kind: "bad_request",
  });
});

it("fails closed for read grants, unqualified providers, disabled spool and revocation", async () => {
  const f = await fixture();
  const input = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "new",
  };
  for (const p of [
    { ...f.principal, tokenAccess: { mode: "read" as const, paths: ["/"] } },
    { ...f.principal, storage: f.raw },
  ]) {
    expect(f.service.capabilities(p)).toEqual(NO_WRITES);
    await expect(f.service.prepare(p, input)).rejects.toMatchObject({ kind: "forbidden" });
  }
  const disabled = createDesktopWrites({ ...f.deps, stateDir: undefined } as never);
  expect(disabled.capabilities(f.principal)).toEqual(NO_WRITES);
  await expect(disabled.prepare(f.principal, input)).rejects.toMatchObject({ kind: "forbidden" });
  await f.service.prepare(f.principal, input);
  vi.mocked(required(f.principal.verifyAuthority)).mockResolvedValue(false);
  await expect(f.service.commit(f.principal, input.operationId)).rejects.toMatchObject({
    kind: "unauthorized",
  });
  await expect(
    f.service.status({ ...f.principal, accountId: randomUUID() }, input.operationId),
  ).rejects.toMatchObject({ kind: "not_found" });
});

it("bounds and verifies uploads, resets failed transfers and cancels only unpublished operations", async () => {
  const f = await fixture();
  const request = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "new",
    base: null,
    size: 3,
    sha256: sha("abc"),
  };
  await expect(
    f.service.prepare(f.principal, { ...request, size: 17 * 1024 ** 3 }),
  ).rejects.toMatchObject({ details: { code: "quota_exceeded" } });
  await expect(
    f.service.prepare(f.principal, { ...request, itemId: randomUUID() }),
  ).rejects.toMatchObject({ kind: "bad_request" });
  await f.service.prepare(f.principal, request);
  for (const bytes of ["too long", "x", "xyz"]) {
    await expect(
      f.service.upload(f.principal, request.operationId, body(bytes), new AbortController().signal),
    ).rejects.toMatchObject({ details: { code: "invalid_upload" } });
    expect((await f.service.status(f.principal, request.operationId)).state).toBe("receiving");
  }
  const aborted = AbortSignal.abort();
  await expect(
    f.service.upload(f.principal, request.operationId, body("abc"), aborted),
  ).rejects.toBeDefined();
  await f.service.upload(
    f.principal,
    request.operationId,
    body("abc"),
    new AbortController().signal,
  );
  expect((await f.service.cancel(f.principal, request.operationId)).state).toBe("cancelled");
  expect((await f.service.cancel(f.principal, request.operationId)).state).toBe("cancelled");
  await expect(f.service.acknowledge(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "conflict",
  });
  const folder = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "folder2",
  };
  await f.service.prepare(f.principal, folder);
  await expect(
    f.service.upload(f.principal, folder.operationId, body("bad"), new AbortController().signal),
  ).rejects.toMatchObject({ kind: "bad_request" });
  await f.service.commit(f.principal, folder.operationId);
  await expect(f.service.cancel(f.principal, folder.operationId)).rejects.toMatchObject({
    kind: "conflict",
  });
});

it("never replays a publication with a lost response and retains recovery bytes", async () => {
  const f = await fixture();
  const input = await f.stage("new", "complete");
  const move = f.raw.move.bind(f.raw);
  f.raw.move = vi.fn(async (path: string, target: string) => {
    await move(path, target);
    throw Error("connection lost after commit");
  });
  await expect(f.service.commit(f.principal, input.operationId)).rejects.toMatchObject({
    details: { code: "operation_uncertain" },
  });
  expect(await f.read("/new")).toBe("complete");
  expect((await f.service.commit(f.principal, input.operationId)).state).toBe("uncertain");
  expect(f.raw.move).toHaveBeenCalledTimes(1);
  await expect(f.service.cancel(f.principal, input.operationId)).rejects.toMatchObject({
    kind: "conflict",
  });
});

it("leaves the original untouched when staging or lease acquisition fails", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const input = await f.stage("old.txt", "new", original);
  f.raw.upload = vi.fn(async () => {
    throw new StorageError("forbidden", "Denied");
  });
  await expect(f.service.commit(f.principal, input.operationId)).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(await f.read("/old.txt")).toBe("old");
  expect((await f.service.status(f.principal, input.operationId)).state).toBe("ready");
  vi.mocked(required(f.storage.withWriteLease)).mockRejectedValueOnce(
    new StorageError("conflict", "Locked"),
  );
  await expect(f.service.commit(f.principal, input.operationId)).rejects.toMatchObject({
    kind: "conflict",
  });
});

it("keeps internal storage out of ordinary reads and enforces opaque operation ownership", async () => {
  const f = await fixture();
  const input = await f.stage("created", "body");
  await f.service.commit(f.principal, input.operationId);
  expect(
    (await f.service.list(f.principal, "/", "token")).entries.map((e) => e.path),
  ).not.toContain("/.fdrive-desktop");
  await expect(f.service.stat(f.principal, "/.fdrive-desktop")).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(
    await new Response(
      (await f.service.files.content(f.principal, "/created", new AbortController().signal)).body,
    ).text(),
  ).toBe("body");
  expect(
    (await f.service.files.versions(f.principal, ["/created"], new AbortController().signal))
      .items[0]?.version,
  ).toBe(sha("body"));
  expect((await f.service.stat(f.principal, DESKTOP_TRASH)).id).toBe("trash");
  await expect(f.service.stat(f.principal, `${DESKTOP_TRASH}/unknown`)).rejects.toMatchObject({
    kind: "forbidden",
  });
  await expect(
    f.service.prepare(f.principal, {
      kind: "folder",
      operationId: randomUUID(),
      parentId: randomUUID(),
      name: "missing",
    }),
  ).rejects.toMatchObject({ kind: "not_found" });
});

it("preserves file/folder contents and handles through scoped Trash and restore", async () => {
  const f = await fixture();
  for (const path of ["/old.txt", "/folder"]) {
    const original = await f.service.stat(f.principal, path);
    const move = {
      kind: "move" as const,
      operationId: randomUUID(),
      itemId: original.id,
      parentId: "trash",
      name: original.name,
      base: {
        ...original.version,
        content: original.kind === "file" ? sha("old") : original.version.content,
      },
    };
    await f.service.prepare(f.principal, move);
    const trashed = required((await f.service.commit(f.principal, move.operationId)).item);
    expect(trashed.id).toBe(original.id);
    expect(trashed.trashed).toBe(true);
    expect(trashed.parentId).toBe("trash");
    expect(trashed.capabilities.update).toBe(false);
    expect(
      (await f.service.list(f.principal, DESKTOP_TRASH, "token")).entries.map((e) => e.id),
    ).toContain(original.id);
    const stat = await f.service.stat(f.principal, trashed.path);
    expect(stat.id).toBe(original.id);
    const contentPath = original.kind === "file" ? trashed.path : `${trashed.path}/child`;
    expect(
      await new Response(
        (await f.service.files.content(f.principal, contentPath, new AbortController().signal))
          .body,
      ).text(),
    ).toBe(original.kind === "file" ? "old" : "child");
    expect(
      (await f.service.files.versions(f.principal, [contentPath], new AbortController().signal))
        .items[0]?.version,
    ).toBe(sha(original.kind === "file" ? "old" : "child"));
    if (original.kind === "dir") {
      expect((await f.service.list(f.principal, trashed.path, "token")).entries).toHaveLength(1);
      await expect(
        f.service.files.content(f.principal, trashed.path, new AbortController().signal),
      ).rejects.toMatchObject({ kind: "bad_request" });
      await expect(
        f.service.files.versions(f.principal, [trashed.path], new AbortController().signal),
      ).rejects.toMatchObject({ kind: "bad_request" });
    }
    const restore = {
      ...move,
      operationId: randomUUID(),
      parentId: "root",
      name: trashed.name,
      base: { ...trashed.version, content: move.base.content },
    };
    await f.service.prepare(f.principal, restore);
    const restored = required((await f.service.commit(f.principal, restore.operationId)).item);
    expect(restored.id).toBe(original.id);
    expect(restored.path).toBe(path);
    expect(restored.trashed).toBe(false);
  }
  expect((await f.service.list(f.principal, DESKTOP_TRASH, "token")).entries).toHaveLength(0);
  await expect(
    f.service.list(f.principal, DESKTOP_TRASH, "token", "expired"),
  ).rejects.toMatchObject({ kind: "conflict" });
  const create = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "trash",
    name: "invalid",
  };
  await f.service.prepare(f.principal, create);
  await expect(f.service.commit(f.principal, create.operationId)).rejects.toMatchObject({
    kind: "bad_request",
  });
});

it("keeps recovery names within macOS byte limits and retains their extension", async () => {
  const f = await fixture();
  for (const name of [`${"å".repeat(120)}.txt`, `file.${"x".repeat(100)}`]) {
    await f.raw.upload(`/${name}`, body("bytes"), { overwrite: false });
    const original = await f.service.stat(f.principal, `/${name}`);
    const move = {
      kind: "move" as const,
      operationId: randomUUID(),
      itemId: original.id,
      parentId: "trash",
      name,
      base: original.version,
    };
    await f.service.prepare(f.principal, move);
    const item = required((await f.service.commit(f.principal, move.operationId)).item);
    expect(Buffer.byteLength(item.name)).toBeLessThanOrEqual(255);
    expect(item.name).toContain(" (deleted ");
    if (name.endsWith(".txt")) expect(item.name.endsWith(".txt")).toBe(true);
    const restore = {
      ...move,
      operationId: randomUUID(),
      parentId: "root",
      name: item.name,
      base: item.version,
    };
    await f.service.prepare(f.principal, restore);
    expect((await f.service.commit(f.principal, restore.operationId)).item?.name).toBe(name);
  }
});

it("restarts an interrupted incoming body without letting the abandoned attempt publish", async () => {
  const f = await fixture();
  const request = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "new",
    base: null,
    size: 3,
    sha256: sha("abc"),
  };
  await f.service.prepare(f.principal, request);
  await f.repo.transition(
    f.principal.identityId,
    f.principal.accountId,
    request.operationId,
    "receiving",
    "uploading",
    { attempt: randomUUID() },
  );
  const restarted = createDesktopWrites(f.deps);
  expect(
    (
      await restarted.upload(
        f.principal,
        request.operationId,
        body("abc"),
        new AbortController().signal,
      )
    ).state,
  ).toBe("ready");
  expect(
    await f.repo.transition(
      f.principal.identityId,
      f.principal.accountId,
      request.operationId,
      "uploading",
      "ready",
      {},
      "abandoned",
    ),
  ).toBe(false);
  await restarted.commit(f.principal, request.operationId);
  expect(await f.read("/new")).toBe("abc");
});

it("refuses invalid parents and replacement of directories, and translates capacity failures", async () => {
  const f = await fixture();
  const file = await f.service.stat(f.principal, "/old.txt");
  const folder = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: file.id,
    name: "invalid",
  };
  await f.service.prepare(f.principal, folder);
  await expect(f.service.commit(f.principal, folder.operationId)).rejects.toMatchObject({
    kind: "bad_request",
  });
  const directory = await f.service.stat(f.principal, "/folder");
  const replacement = await f.stage("folder", "new", directory);
  await expect(f.service.commit(f.principal, replacement.operationId)).rejects.toMatchObject({
    kind: "bad_request",
  });
  const reserve = vi
    .spyOn(f.repo, "reserve")
    .mockRejectedValueOnce(Error("Desktop recovery capacity reached"));
  await expect(
    f.service.prepare(f.principal, { ...folder, operationId: randomUUID(), parentId: "root" }),
  ).rejects.toMatchObject({ details: { code: "quota_exceeded" } });
  reserve.mockRejectedValueOnce(Error("database unavailable"));
  await expect(
    f.service.prepare(f.principal, { ...folder, operationId: randomUUID(), parentId: "root" }),
  ).rejects.toThrow("database unavailable");
});

it("preserves the source on corrupt staging, corrupt backups and incomplete hashes", async () => {
  for (const fault of ["stage", "backup", "incomplete"] as const) {
    const f = await fixture();
    const original = await f.service.stat(f.principal, "/old.txt");
    const input = await f.stage("old.txt", "new", original);
    const download = f.raw.download.bind(f.raw);
    f.raw.download = async (path, options) => {
      const result = await download(path, options);
      if (
        (fault === "stage" && path.endsWith("/incoming")) ||
        (fault === "backup" && path.endsWith("/previous"))
      )
        return { ...result, body: body("bad") };
      if (fault === "incomplete" && path === "/old.txt") return { ...result, contentLength: 999 };
      return result;
    };
    await expect(f.service.commit(f.principal, input.operationId)).rejects.toThrow();
    expect(await f.read("/old.txt")).toBe("old");
    expect((await f.service.status(f.principal, input.operationId)).state).toBe("ready");
  }
});

it("commits a combined save and rename only after preserving the previous bytes", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const input = await f.stage("renamed.txt", "new", original);
  const result = await f.service.commit(f.principal, input.operationId);
  expect(result.item?.id).toBe(original.id);
  expect(await f.read("/renamed.txt")).toBe("new");
  await expect(f.raw.stat("/old.txt")).rejects.toMatchObject({ kind: "not_found" });
});

it("retains verified upload bytes when the database loses its ready response", async () => {
  const f = await fixture();
  const request = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "new",
    base: null,
    size: 3,
    sha256: sha("abc"),
  };
  await f.service.prepare(f.principal, request);
  const transition = f.repo.transition.bind(f.repo);
  vi.spyOn(f.repo, "transition").mockImplementation(async (...args) => {
    const result = await transition(...args);
    if (args[4] === "ready") throw Error("Response lost after database commit");
    return result;
  });
  expect(
    (
      await f.service.upload(
        f.principal,
        request.operationId,
        body("abc"),
        new AbortController().signal,
      )
    ).state,
  ).toBe("ready");
  await f.service.commit(f.principal, request.operationId);
  expect(await f.read("/new")).toBe("abc");
});

it("serializes duplicate commits and marks a lost final receipt uncertain", async () => {
  const f = await fixture();
  const request = await f.stage("new", "abc");
  const results = await Promise.all([
    f.service.commit(f.principal, request.operationId),
    f.service.commit(f.principal, request.operationId),
  ]);
  expect(results.some((result) => result.state === "completed")).toBe(true);
  expect(f.storage.withWriteLease).toHaveBeenCalledTimes(1);
  const second = await f.stage("receipt-lost", "def");
  const transition = f.repo.transition.bind(f.repo);
  vi.spyOn(f.repo, "transition").mockImplementation(async (...args) =>
    args[4] === "completed" ? false : transition(...args),
  );
  await expect(f.service.commit(f.principal, second.operationId)).rejects.toMatchObject({
    details: { code: "operation_uncertain" },
  });
  expect(await f.read("/receipt-lost")).toBe("def");
});

it("rejects a substituted recovery directory and a missing payload receipt", async () => {
  const f = await fixture();
  const request = await f.stage("new", "abc");
  await f.raw.upload("/.fdrive-desktop", new Uint8Array());
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(await f.read("/old.txt")).toBe("old");
  const second = await fixture();
  const input = await second.stage("new", "abc");
  const op = required(second.operations.get(second.principal.identityId + input.operationId));
  second.operations.set(second.principal.identityId + input.operationId, { ...op, result: null });
  await expect(second.service.commit(second.principal, input.operationId)).rejects.toThrow(
    "Missing upload receipt",
  );
  expect((await second.service.status(second.principal, input.operationId)).state).toBe("ready");
});

it("bounds Trash listings and surfaces upstream failures instead of returning an empty snapshot", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const move = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: original.id,
    parentId: "trash",
    name: original.name,
    base: { ...original.version, content: sha("old") },
  };
  await f.service.prepare(f.principal, move);
  const result = required((await f.service.commit(f.principal, move.operationId)).item);
  const list = f.storage.list.bind(f.storage);
  const denied = vi
    .spyOn(f.storage, "list")
    .mockRejectedValueOnce(new StorageError("upstream_unavailable", "Offline"));
  await expect(f.service.list(f.principal, DESKTOP_TRASH, "token")).rejects.toThrow("Offline");
  denied.mockImplementation(async (path) =>
    (await list(path)).map((item) =>
      item.path.endsWith(`/${original.id}`) ? { ...item, kind: "symlink" } : item,
    ),
  );
  await expect(f.service.stat(f.principal, result.path)).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect((await f.service.list(f.principal, DESKTOP_TRASH, "token")).entries).toEqual([]);
  vi.spyOn(f.repo, "children").mockResolvedValueOnce(Array(100_001).fill({}));
  await expect(f.service.list(f.principal, DESKTOP_TRASH, "token")).rejects.toMatchObject({
    kind: "rate_limited",
  });
});

it("cancels an active body even when stream cancellation fails and preserves its original error", async () => {
  const f = await fixture();
  const request = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "new",
    base: null,
    size: 3,
    sha256: sha("abc"),
  };
  await f.service.prepare(f.principal, request);
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      sink.enqueue(new TextEncoder().encode("a"));
    },
    pull() {
      controller.abort(new Error("Disconnected"));
    },
    cancel() {
      throw Error("Socket already gone");
    },
  });
  await expect(
    f.service.upload(f.principal, request.operationId, stream, controller.signal),
  ).rejects.toBeDefined();
  expect((await f.service.status(f.principal, request.operationId)).state).toBe("receiving");
  expect(await readdir(join(f.stateDir, f.principal.identityId, request.operationId))).toEqual([]);
  await f.service.upload(
    f.principal,
    request.operationId,
    body("abc"),
    new AbortController().signal,
  );
  await f.service.commit(f.principal, request.operationId);
  expect(await f.read("/new")).toBe("abc");
});

it("keeps an interrupted payload if both database status and reset are unavailable", async () => {
  const f = await fixture();
  const request = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "new",
    base: null,
    size: 3,
    sha256: sha("abc"),
  };
  await f.service.prepare(f.principal, request);
  const original = f.repo.operation.bind(f.repo);
  let reads = 0;
  vi.spyOn(f.repo, "operation").mockImplementation(async (...args) => {
    if (reads++ > 0) throw Error("Database unavailable");
    return original(...args);
  });
  const transition = f.repo.transition.bind(f.repo);
  vi.spyOn(f.repo, "transition").mockImplementation(async (...args) => {
    if (args[4] === "receiving") throw Error("Database unavailable");
    return transition(...args);
  });
  await expect(
    f.service.upload(f.principal, request.operationId, body("wrong"), new AbortController().signal),
  ).rejects.toMatchObject({ details: { code: "invalid_upload" } });
  expect(await readdir(join(f.stateDir, f.principal.identityId, request.operationId))).toHaveLength(
    1,
  );
  expect(await f.read("/old.txt")).toBe("old");
});

it("rechecks source grants and metadata under the lease and forbids editing recovery entries", async () => {
  const f = await fixture();
  const source = await f.service.stat(f.principal, "/old.txt");
  const input = await f.stage("old.txt", "changed", source);
  const sourceOnly = {
    ...f.principal,
    tokenAccess: { mode: "full" as const, paths: ["/old.txt"] },
  };
  const folder = await f.service.stat(f.principal, "/folder");
  const move = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: source.id,
    parentId: folder.id,
    name: "moved",
    base: source.version,
  };
  await f.service.prepare(f.principal, move);
  await expect(
    f.service.commit(
      { ...sourceOnly, tokenAccess: { mode: "full", paths: ["/folder"] } },
      move.operationId,
    ),
  ).rejects.toMatchObject({ kind: "forbidden" });
  await f.repo.update(f.principal.identityId, source.id, { contentVersion: "new metadata" });
  await expect(f.service.commit(f.principal, input.operationId)).rejects.toMatchObject({
    details: { code: "version_conflict" },
  });
  const current = await f.service.stat(f.principal, "/old.txt");
  const trash = { ...move, operationId: randomUUID(), parentId: "trash", base: current.version };
  await f.service.prepare(f.principal, trash);
  const trashed = required((await f.service.commit(f.principal, trash.operationId)).item);
  await expect(f.stage("new", "bytes", trashed)).rejects.toMatchObject({
    kind: "forbidden",
  });
});

it("reuses one durable staging directory after interruption and never duplicates its backup", async () => {
  const f = await fixture();
  const source = await f.service.stat(f.principal, "/old.txt");
  const request = await f.stage("old.txt", "new", source);
  const download = f.raw.download.bind(f.raw);
  const copy = vi.spyOn(f.raw, "copy");
  let interrupted = true;
  f.raw.download = async (path, options) => {
    if (path.endsWith("/previous") && interrupted) {
      interrupted = false;
      throw new StorageError("upstream_unavailable", "Disconnected after backup");
    }
    return download(path, options);
  };
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toThrow("Disconnected");
  const receipt = required(
    (await f.repo.operation(f.principal.identityId, f.principal.accountId, request.operationId))
      ?.result,
  );
  const root = `/.fdrive-desktop/${f.principal.identityId}/${request.operationId}`;
  expect(await f.raw.list(root)).toHaveLength(1);
  const result = await f.service.commit(f.principal, request.operationId);
  expect(result.state).toBe("completed");
  expect(await f.read("/old.txt")).toBe("new");
  expect(copy.mock.calls.filter((call) => call[1].endsWith("/previous"))).toHaveLength(1);
  expect((await f.raw.list(root))[0]?.name).toBe(receipt.remoteAttempt);
  // Replaying prepare after a later rename must still return the original receipt.
  await f.raw.move("/old.txt", "/later");
  await f.repo.move(f.principal.identityId, "/old.txt", "/later");
  expect(await f.service.prepare(f.principal, request)).toEqual(result);
});

it("rejects substituted staging entries and cannot publish without a durable recovery reservation", async () => {
  for (const fault of ["incoming", "previous", "receipt"] as const) {
    const f = await fixture();
    const source = await f.service.stat(f.principal, "/old.txt");
    const request = await f.stage("old.txt", "new", source);
    const attempt = randomUUID();
    const operation = required(f.operations.get(f.principal.identityId + request.operationId));
    operation.result = { ...operation.result, remoteAttempt: attempt };
    const root = `/.fdrive-desktop/${f.principal.identityId}/${request.operationId}/${attempt}`;
    if (fault === "receipt") {
      const transition = f.repo.transition.bind(f.repo);
      vi.spyOn(f.repo, "transition").mockImplementation(async (...args) =>
        args[3] === "committing" && args[4] === "committing" ? false : transition(...args),
      );
    } else {
      let current = "";
      for (const part of `${root}/${fault}`.slice(1).split("/")) {
        current += `/${part}`;
        await f.raw.mkdir(current);
      }
    }
    await expect(f.service.commit(f.principal, request.operationId)).rejects.toThrow();
    expect(await f.read("/old.txt")).toBe("old");
    expect((await f.service.status(f.principal, request.operationId)).state).toBe("ready");
  }
});

it("allows exactly one request and one receiver when callers race the same operation", async () => {
  const f = await fixture();
  const input = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "a",
    base: null,
    size: 3,
    sha256: sha("abc"),
  };
  const requests = await Promise.allSettled([
    f.service.prepare(f.principal, input),
    f.service.prepare(f.principal, { ...input, name: "b" }),
  ]);
  expect(requests.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(requests.filter((r) => r.status === "rejected")).toHaveLength(1);
  const transfers = await Promise.all([
    f.service.upload(f.principal, input.operationId, body("abc"), new AbortController().signal),
    f.service.upload(f.principal, input.operationId, body("abc"), new AbortController().signal),
  ]);
  expect(transfers.map((r) => r.state)).toContain("ready");
  expect(transfers.map((r) => r.state)).toContain("uploading");
  expect((await f.service.commit(f.principal, input.operationId)).state).toBe("completed");
});

it("fences an old upload process and cleans its unreferenced snapshot", async () => {
  const f = await fixture();
  const input = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "new",
    base: null,
    size: 3,
    sha256: sha("abc"),
  };
  await f.service.prepare(f.principal, input);
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
    pull() {
      started?.();
    },
  });
  const first = f.service.upload(
    f.principal,
    input.operationId,
    stream,
    new AbortController().signal,
  );
  const rejected = expect(first).rejects.toThrow("superseded");
  await ready;
  // Wait for the first receiver's durable uploading receipt, not elapsed time.
  await vi.waitFor(async () =>
    expect(await readdir(join(f.stateDir, f.principal.identityId, input.operationId))).toHaveLength(
      1,
    ),
  );
  const second = createDesktopWrites(f.deps);
  await second.upload(f.principal, input.operationId, body("abc"), new AbortController().signal);
  required(sink).enqueue(new TextEncoder().encode("abc"));
  required(sink).close();
  await rejected;
  expect(await readdir(join(f.stateDir, f.principal.identityId, input.operationId))).toHaveLength(
    1,
  );
  await second.commit(f.principal, input.operationId);
  expect(await f.read("/new")).toBe("abc");
});

it("does not let a readable ancestor become a writable move source", async () => {
  const f = await fixture();
  await f.raw.mkdir("/destination");
  const source = await f.service.stat(f.principal, "/folder");
  const destination = await f.service.stat(f.principal, "/destination");
  const scoped = {
    ...f.principal,
    tokenAccess: { mode: "full" as const, paths: ["/folder/child", "/destination"] },
  };
  const request = {
    kind: "move" as const,
    operationId: randomUUID(),
    parentId: destination.id,
    itemId: source.id,
    name: "moved",
    base: source.version,
  };
  await f.service.prepare(scoped, request);
  await expect(f.service.commit(scoped, request.operationId)).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(await f.read("/folder/child")).toBe("child");
});

it("preserves a save when its source is trashed after preparation or a hashing stream breaks", async () => {
  const f = await fixture();
  const source = await f.service.stat(f.principal, "/old.txt");
  const upload = await f.stage("old.txt", "new", source);
  const download = f.raw.download.bind(f.raw);
  f.raw.download = async (...args) => ({
    ...(await download(...args)),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("Hash stream failed"));
      },
    }),
  });
  await expect(f.service.commit(f.principal, upload.operationId)).rejects.toThrow(
    "Hash stream failed",
  );
  f.raw.download = download;
  const trash = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: source.id,
    parentId: "trash",
    name: source.name,
    base: source.version,
  };
  await f.service.prepare(f.principal, trash);
  const receipt = required((await f.service.commit(f.principal, trash.operationId)).item);
  await expect(f.service.commit(f.principal, upload.operationId)).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(
    await new Response(
      (await f.service.files.content(f.principal, receipt.path, new AbortController().signal)).body,
    ).text(),
  ).toBe("old");
});

it("blocks a new publication while an earlier save needs metadata recovery", async () => {
  const f = await fixture();
  const request = await f.stage("new.txt", "saved");
  const effects = {
    beforeWrite: vi.fn(async (): Promise<void> => {
      throw new StorageError("upstream_unavailable", "Recovery pending");
    }),
    kick: vi.fn(),
  };
  const service = createDesktopWrites({ ...f.deps, effects });
  await expect(service.commit(f.principal, request.operationId)).rejects.toThrow(
    "Recovery pending",
  );
  expect(
    (await f.repo.operation(f.principal.identityId, f.principal.accountId, request.operationId))
      ?.state,
  ).toBe("ready");
  expect((await f.raw.list("/")).map((item) => item.path)).not.toContain("/new.txt");
  effects.beforeWrite.mockResolvedValueOnce(undefined);
  expect((await service.commit(f.principal, request.operationId)).state).toBe("completed");
  expect(await f.read("/new.txt")).toBe("saved");
});

it("keeps the committed receipt when waking metadata recovery fails", async () => {
  const f = await fixture();
  const request = await f.stage("saved.txt", "saved");
  const service = createDesktopWrites({
    ...f.deps,
    effects: {
      beforeWrite: async () => {},
      kick: () => {
        throw Error("worker unavailable");
      },
    },
  });
  const receipt = await service.commit(f.principal, request.operationId);
  expect(receipt.state).toBe("completed");
  expect(await service.commit(f.principal, request.operationId)).toEqual(receipt);
  expect(await f.read("/saved.txt")).toBe("saved");
});

it("refuses overlapping restore metadata paths before changing storage", async () => {
  const f = await fixture();
  const source = await f.service.stat(f.principal, "/folder");
  const trashId = randomUUID();
  await f.service.prepare(f.principal, {
    kind: "move",
    operationId: trashId,
    itemId: source.id,
    parentId: "trash",
    name: "folder",
    base: source.version,
  });
  const trashed = required((await f.service.commit(f.principal, trashId)).item);
  await f.raw.mkdir("/folder");
  const parent = await f.service.stat(f.principal, "/folder");
  const restoreId = randomUUID();
  await f.service.prepare(f.principal, {
    kind: "move",
    operationId: restoreId,
    itemId: trashed.id,
    parentId: parent.id,
    name: "nested",
    base: trashed.version,
  });
  await expect(f.service.commit(f.principal, restoreId)).rejects.toMatchObject({
    kind: "conflict",
    details: { code: "unsupported" },
  });
  expect((await f.service.stat(f.principal, trashed.path)).trashed).toBe(true);
  expect(await f.raw.list("/folder")).toEqual([]);
});

it.each(["folder", "move"] as const)(
  "rechecks authority after recovery waits before publishing a %s",
  async (kind) => {
    const f = await fixture();
    const item = await f.service.stat(f.principal, "/old.txt");
    const operationId = randomUUID();
    await f.service.prepare(
      f.principal,
      kind === "folder"
        ? { kind, operationId, parentId: "root", name: "new" }
        : { kind, operationId, parentId: "root", itemId: item.id, name: "new", base: item.version },
    );
    const service = createDesktopWrites({
      ...f.deps,
      effects: {
        beforeWrite: async () => {
          vi.mocked(required(f.principal.verifyAuthority)).mockResolvedValue(false);
        },
        kick: () => {},
      },
    });
    await expect(service.commit(f.principal, operationId)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect((await f.raw.list("/")).map((entry) => entry.path)).not.toContain("/new");
    expect(await f.read("/old.txt")).toBe("old");
  },
);

it("rejects metadata capacity before staging or publishing, and retries the same operation", async () => {
  const f = await fixture();
  const existing = await f.service.stat(f.principal, "/old.txt");
  const request = await f.stage("old.txt", "new", existing);
  vi.spyOn(f.repo, "captureEffects").mockRejectedValueOnce(
    Error("Desktop metadata recovery capacity reached"),
  );
  const upload = vi.spyOn(f.raw, "upload");
  const move = vi.spyOn(f.raw, "move");
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "rate_limited",
    details: { code: "quota_exceeded" },
  });
  expect(upload).not.toHaveBeenCalled();
  expect(move).not.toHaveBeenCalled();
  expect(await f.read("/old.txt")).toBe("old");
  expect((await f.service.status(f.principal, request.operationId)).state).toBe("ready");
  expect((await f.service.commit(f.principal, request.operationId)).state).toBe("completed");
  expect(await f.read("/old.txt")).toBe("new");
});
