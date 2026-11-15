import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopWriteEntry } from "@fdrive/contracts";
import { isStorageError, type MoveOptions, StorageError } from "@fdrive/core";
import type { DesktopAccessMove } from "@fdrive/db";
import { createLocalStorage } from "@fdrive/local";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { memoryRepo } from "../../test/helpers/desktop-repo.js";
import type { Principal } from "../auth/principal.js";
import { createDesktopRetention, removeIncoming } from "./retention.js";
import { createDesktopWrites, DESKTOP_TRASH, NO_WRITES } from "./writes.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ALL_WRITES = { create: true, update: true, move: true, trash: true, restore: true };
function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Missing fixture value");
  return value;
}
const body = (value: string) => required(new Response(value).body);
/**
 * A call that never returns, as one in a process that died there: `made`
 * resolves once it is called. A service built afresh stands for the restart.
 */
function crashAt() {
  let reached: () => void = () => undefined;
  const made = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return {
    made,
    call: (): Promise<never> => {
      reached();
      return new Promise<never>(() => undefined);
    },
  };
}
/** The names an operation has staged in its owner's files. */
async function staged(
  f: { raw: { list(path: string): Promise<{ name: string }[]> }; principal: Principal },
  operationId: string,
) {
  try {
    return (
      await f.raw.list(`/.fdrive-desktop/${f.principal.identityId}/incoming/${operationId}`)
    ).map((entry) => entry.name);
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") return [];
    throw error;
  }
}
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const memory = memoryRepo();
  const raw = createMemoryStorage({ "/old.txt": "old", "/folder/child": "child" });
  const storage = raw;
  const principal: Principal = {
    accountId: randomUUID(),
    identityId: randomUUID(),
    username: "test",
    isAdmin: false,
    storage,
    tokenAccess: { mode: "full", paths: ["/"] },
  };
  // Every move is one the owner's public links follow, in the owner's files.
  const access = vi.fn(
    async (identityId: string, from: string, to: string, directory: boolean) =>
      ({ directory, shares: { identityId, from, to }, grants: null }) as DesktopAccessMove,
  );
  const metadata = { onMoved: vi.fn(async () => {}) };
  const deps = {
    repo: memory.repo,
    storageForIdentity: async () => raw,
    clock: () => new Date(),
    access,
    metadata,
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
    stage,
    read,
    access,
    metadata,
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
  // Staged in the owner's files, beside the Mac's Trash.
  expect(
    await f.read(
      `/.fdrive-desktop/${f.principal.identityId}/incoming/${request.operationId}/${required(op.result).uploadFile}`,
    ),
  ).toBe("saved");
  const result = await f.service.commit(f.principal, request.operationId);
  expect(result.item?.id).toBe(original.id);
  expect(result.item?.version.content).toBe(sha("saved"));
  expect(await f.read("/old.txt")).toBe("saved");
  expect(f.completed.get(request.operationId)).toEqual({
    from: "/old.txt",
    to: "/old.txt",
    directory: false,
    trash: false,
  });
  // A save in place moves no metadata.
  expect(f.metadata.onMoved).not.toHaveBeenCalled();
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
  // No copy of what the save replaced is kept, and its staging folder is gone.
  expect(result.recoveryId).toBeNull();
  expect(await f.raw.list(`/.fdrive-desktop/${f.principal.identityId}/incoming`)).toEqual([]);
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
  await f.raw.upload("/old.txt", new TextEncoder().encode("new"), { overwrite: true });
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

it("fails closed for read grants, and needs nothing else", async () => {
  const f = await fixture();
  const input = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "new",
  };
  const readOnly: Principal = { ...f.principal, tokenAccess: { mode: "read", paths: ["/"] } };
  expect(f.service.capabilities(readOnly)).toEqual(NO_WRITES);
  expect(f.service.capabilities(f.principal)).toEqual(ALL_WRITES);
  await expect(f.service.prepare(readOnly, input)).rejects.toMatchObject({ kind: "forbidden" });
  await f.service.prepare(f.principal, input);
  await expect(f.service.commit(readOnly, input.operationId)).rejects.toMatchObject({
    kind: "forbidden",
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

it("cancels stale uploads and forgets finished operations with what they staged", async () => {
  const f = await fixture();
  const eventLog = { record: vi.fn() };
  let now = new Date();
  let unavailable = "";
  const retention = createDesktopRetention({
    repo: f.repo,
    storageForIdentity: async (identityId) => {
      if (identityId === unavailable) throw Error("storage is down");
      return f.raw;
    },
    clock: () => now,
    eventLog,
  });
  const key = (id: string) => f.principal.identityId + id;
  const incoming = `/.fdrive-desktop/${f.principal.identityId}/incoming`;
  const staged = async () => (await f.raw.list(incoming)).map((entry) => entry.name).sort();
  // An acknowledged save leaves nothing behind; one a crash interrupted
  // left its body, which goes when its operation is forgotten.
  const original = await f.service.stat(f.principal, "/old.txt");
  const replaced = await f.stage("old.txt", "new", original);
  await f.service.commit(f.principal, replaced.operationId);
  await f.service.acknowledge(f.principal, replaced.operationId);
  expect(await staged()).toEqual([]);
  await f.raw.upload(`${incoming}/${replaced.operationId}/${randomUUID()}`, body("left"), {
    mkdirParents: true,
  });
  // A body that never finished and a conflict nobody retried.
  const idle = await f.stage("idle.txt", "idle");
  f.operations.set(key(idle.operationId), {
    ...required(f.operations.get(key(idle.operationId))),
    state: "uploading",
  });
  const conflicted = await f.stage("conflict.txt", "conflict");
  f.operations.set(key(conflicted.operationId), {
    ...required(f.operations.get(key(conflicted.operationId))),
    state: "conflict",
  });
  // Ready and committing operations may still publish what they staged, however old.
  const ready = await f.stage("ready.txt", "ready");
  const committing = await f.stage("committing.txt", "committing");
  f.operations.set(key(committing.operationId), {
    ...required(f.operations.get(key(committing.operationId))),
    state: "committing",
  });
  expect(await retention.sweep()).toEqual({ cancelled: 0, forgotten: 0, deferred: 0 });
  now = new Date(now.getTime() + 31 * 24 * 60 * 60_000);
  expect(await retention.sweep()).toEqual({ cancelled: 2, forgotten: 1, deferred: 0 });
  expect((await f.service.status(f.principal, idle.operationId)).state).toBe("cancelled");
  expect((await f.service.status(f.principal, conflicted.operationId)).state).toBe("cancelled");
  expect(f.operations.has(key(replaced.operationId))).toBe(false);
  expect(await staged()).toEqual([ready.operationId, committing.operationId].sort());
  expect((await f.service.status(f.principal, ready.operationId)).state).toBe("ready");
  expect(await f.read("/old.txt")).toBe("new");
  // Cancelled rows are forgotten by a later pass; a second pass changes nothing.
  expect(await retention.sweep()).toEqual({ cancelled: 0, forgotten: 2, deferred: 0 });
  expect(await retention.sweep()).toEqual({ cancelled: 0, forgotten: 0, deferred: 0 });
  // A failure defers that operation to a later pass and says so.
  const late = await f.stage("late.txt", "late");
  f.operations.set(key(late.operationId), {
    ...required(f.operations.get(key(late.operationId))),
    state: "receiving",
    updatedAt: new Date(0),
  });
  unavailable = f.principal.identityId;
  expect(await retention.sweep()).toEqual({ cancelled: 0, forgotten: 0, deferred: 1 });
  expect(eventLog.record).toHaveBeenCalledWith(
    "general",
    "warn",
    "Mac write cleanup deferred",
    expect.objectContaining({ operationId: late.operationId }),
  );
  unavailable = "";
  expect(await retention.sweep()).toEqual({ cancelled: 0, forgotten: 1, deferred: 0 });
  expect(await staged()).toEqual([ready.operationId, committing.operationId].sort());
});

it("finishes a write a crash stopped after its rename when the app retries", async () => {
  const f = await fixture();
  const { identityId } = f.principal;
  // What grants access follows the item: its public links and the folders shared from it.
  const access = vi.fn(
    async (_identity: string, from: string, to: string, directory: boolean) =>
      ({
        directory,
        shares: { identityId, from, to },
        grants: { owner: "test", from, to },
      }) as DesktopAccessMove,
  );
  const item = await f.service.stat(f.principal, "/old.txt");
  const folder = await f.service.stat(f.principal, "/folder");
  const move = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: item.id,
    parentId: folder.id,
    name: "moved.txt",
    base: item.version,
  };
  const crash = crashAt();
  const crashed = createDesktopWrites({
    ...f.deps,
    access,
    repo: { ...f.repo, complete: crash.call },
  });
  await crashed.prepare(f.principal, move);
  void crashed.commit(f.principal, move.operationId);
  await crash.made;
  // The rename happened; its receipt did not.
  expect(await f.read("/folder/moved.txt")).toBe("old");
  expect((await f.service.status(f.principal, move.operationId)).state).toBe("committing");
  expect(f.moved.has(move.operationId)).toBe(false);
  // Every retry starts with the same request, which finishes the commit from disk.
  const restarted = createDesktopWrites({ ...f.deps, access });
  const receipt = await restarted.prepare(f.principal, move);
  expect(receipt).toMatchObject({
    state: "completed",
    item: { id: item.id, path: "/folder/moved.txt" },
  });
  expect(f.moved.get(move.operationId)).toEqual({
    directory: false,
    shares: { identityId, from: "/old.txt", to: "/folder/moved.txt" },
    grants: { owner: "test", from: "/old.txt", to: "/folder/moved.txt" },
  });
  expect(f.completed.get(move.operationId)).toMatchObject({
    from: "/old.txt",
    to: "/folder/moved.txt",
  });
  expect(f.metadata.onMoved).toHaveBeenCalledWith(
    identityId,
    "/old.txt",
    "/folder/moved.txt",
    false,
  );
  expect(await f.read("/folder/moved.txt")).toBe("old");
  expect(f.raw.dump()["/old.txt"]).toBeUndefined();
  expect(await restarted.commit(f.principal, move.operationId)).toEqual(receipt);
  // A save in place the same way: the published body is the one the receipt names.
  const g = await fixture();
  const original = await g.service.stat(g.principal, "/old.txt");
  const save = await g.stage("old.txt", "saved", original);
  const stopped = crashAt();
  void createDesktopWrites({ ...g.deps, repo: { ...g.repo, complete: stopped.call } }).commit(
    g.principal,
    save.operationId,
  );
  await stopped.made;
  expect(await g.read("/old.txt")).toBe("saved");
  expect(await createDesktopWrites(g.deps).prepare(g.principal, save)).toMatchObject({
    state: "completed",
    item: { id: original.id, version: { content: sha("saved") } },
  });
  expect(await g.read("/old.txt")).toBe("saved");
  expect(await staged(g, save.operationId)).toEqual([]);
});

it("publishes a write a crash stopped before its rename once the app retries, and only once", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const save = await f.stage("old.txt", "saved", original);
  const move = f.raw.move.bind(f.raw);
  const crash = crashAt();
  f.raw.move = vi.fn(crash.call);
  void createDesktopWrites(f.deps).commit(f.principal, save.operationId);
  await crash.made;
  // What it was about to publish is recorded; nothing is published.
  expect(await f.read("/old.txt")).toBe("old");
  const op = required(
    await f.repo.operation(f.principal.identityId, f.principal.accountId, save.operationId),
  );
  expect(op.state).toBe("committing");
  expect(op.result?.publication).toMatchObject({ to: "/old.txt" });
  f.raw.move = vi.fn(move);
  const restarted = createDesktopWrites(f.deps);
  // The retry finds it unpublished, and its commit publishes it.
  expect((await restarted.prepare(f.principal, save)).state).toBe("ready");
  expect((await restarted.commit(f.principal, save.operationId)).state).toBe("completed");
  expect(await f.read("/old.txt")).toBe("saved");
  expect(f.raw.move).toHaveBeenCalledTimes(1);
  // A new folder the same way, from a commit retried directly.
  const folder = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "made",
  };
  await f.service.prepare(f.principal, folder);
  const again = crashAt();
  f.raw.move = vi.fn(again.call);
  void createDesktopWrites(f.deps).commit(f.principal, folder.operationId);
  await again.made;
  f.raw.move = vi.fn(move);
  expect(
    (await createDesktopWrites(f.deps).commit(f.principal, folder.operationId)).item,
  ).toMatchObject({ path: "/made", kind: "dir" });
  expect(f.raw.dirs()).toContain("/made");
  expect(await staged(f, folder.operationId)).toEqual([]);
});

it("finishes a trash move and a restore a crash interrupted, from where the item was", async () => {
  const f = await fixture();
  const { identityId } = f.principal;
  const trashRoot = `/.fdrive-desktop/${identityId}/trash`;
  const original = await f.service.stat(f.principal, "/old.txt");
  const trashed = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: original.id,
    parentId: "trash",
    name: original.name,
    base: original.version,
  };
  await f.service.prepare(f.principal, trashed);
  const crash = crashAt();
  void createDesktopWrites({ ...f.deps, repo: { ...f.repo, complete: crash.call } }).commit(
    f.principal,
    trashed.operationId,
  );
  await crash.made;
  const inTrash = await createDesktopWrites(f.deps).prepare(f.principal, trashed);
  expect(inTrash.item).toMatchObject({ trashed: true, parentId: "trash", id: original.id });
  expect(required(await f.repo.item(identityId, original.id))).toMatchObject({
    path: `${trashRoot}/${original.id}`,
    originalPath: "/old.txt",
  });
  expect(f.moved.get(trashed.operationId)?.shares).toEqual({
    identityId,
    from: "/old.txt",
    to: `${trashRoot}/${original.id}`,
  });
  expect(f.metadata.onMoved).toHaveBeenLastCalledWith(
    identityId,
    "/old.txt",
    `${trashRoot}/${original.id}`,
    false,
  );
  // A restore: the request carries the recovery name.
  const restore = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: original.id,
    parentId: "root",
    name: required(inTrash.item).name,
    base: required(inTrash.item).version,
  };
  expect(restore.name).toContain("(deleted ");
  await f.service.prepare(f.principal, restore);
  const again = crashAt();
  void createDesktopWrites({ ...f.deps, repo: { ...f.repo, complete: again.call } }).commit(
    f.principal,
    restore.operationId,
  );
  await again.made;
  const restored = await createDesktopWrites(f.deps).prepare(f.principal, restore);
  expect(restored.item).toMatchObject({ path: "/old.txt", name: "old.txt", trashed: false });
  expect(required(await f.repo.item(identityId, original.id))).toMatchObject({
    path: "/old.txt",
    originalPath: null,
  });
  expect(f.moved.get(restore.operationId)?.shares).toEqual({
    identityId,
    from: `${trashRoot}/${original.id}`,
    to: "/old.txt",
  });
  expect(f.completed.get(restore.operationId)).toMatchObject({ restored: true });
  expect(f.metadata.onMoved).toHaveBeenLastCalledWith(
    identityId,
    `${trashRoot}/${original.id}`,
    "/old.txt",
    false,
  );
});

it("never overwrites a file someone replaced between commit attempts", async () => {
  // Published before a crash, then replaced: the save is a conflict.
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const save = await f.stage("old.txt", "saved", original);
  const crash = crashAt();
  void createDesktopWrites({ ...f.deps, repo: { ...f.repo, complete: crash.call } }).commit(
    f.principal,
    save.operationId,
  );
  await crash.made;
  await f.raw.upload("/old.txt", body("theirs"), { overwrite: true });
  expect((await createDesktopWrites(f.deps).prepare(f.principal, save)).state).toBe("conflict");
  expect(await f.read("/old.txt")).toBe("theirs");
  expect(f.completed.has(save.operationId)).toBe(false);
  // Stopped before its rename, then replaced: the retry's base check refuses it.
  const g = await fixture();
  const before = await g.service.stat(g.principal, "/old.txt");
  const late = await g.stage("old.txt", "saved", before);
  const move = g.raw.move.bind(g.raw);
  const stopped = crashAt();
  g.raw.move = vi.fn(stopped.call);
  void createDesktopWrites(g.deps).commit(g.principal, late.operationId);
  await stopped.made;
  g.raw.move = move;
  await g.raw.upload("/old.txt", body("theirs"), { overwrite: true });
  const restarted = createDesktopWrites(g.deps);
  expect((await restarted.prepare(g.principal, late)).state).toBe("ready");
  await expect(restarted.commit(g.principal, late.operationId)).rejects.toMatchObject({
    details: { code: "version_conflict" },
  });
  expect(await g.read("/old.txt")).toBe("theirs");
  // A move whose item someone moved on after its rename is a conflict too, and moves no links.
  const h = await fixture();
  const item = await h.service.stat(h.principal, "/old.txt");
  const rename = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: item.id,
    parentId: "root",
    name: "renamed.txt",
    base: item.version,
  };
  await h.service.prepare(h.principal, rename);
  const lost = crashAt();
  void createDesktopWrites({ ...h.deps, repo: { ...h.repo, complete: lost.call } }).commit(
    h.principal,
    rename.operationId,
  );
  await lost.made;
  await h.raw.move("/renamed.txt", "/elsewhere.txt");
  expect((await createDesktopWrites(h.deps).commit(h.principal, rename.operationId)).state).toBe(
    "conflict",
  );
  expect(await h.read("/elsewhere.txt")).toBe("old");
  expect(h.moved.has(rename.operationId)).toBe(false);
});

it("runs retention on a timer, logs failed passes and stops cleanly", async () => {
  vi.useFakeTimers();
  try {
    const eventLog = { record: vi.fn() };
    const expired = vi
      .fn<() => Promise<never[]>>()
      .mockRejectedValueOnce(Error("db down"))
      .mockResolvedValue([]);
    const retention = createDesktopRetention({
      repo: { expired, transition: vi.fn(async () => true), forget: vi.fn(async () => true) },
      storageForIdentity: async () => createMemoryStorage({}),
      clock: () => new Date(),
      eventLog,
    });
    retention.start();
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(eventLog.record).toHaveBeenCalledWith("general", "error", "Mac write cleanup failed", {
      error: "db down",
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(expired).toHaveBeenCalledTimes(2);
    await retention.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(expired).toHaveBeenCalledTimes(2);
    retention.start();
    expect(await retention.sweep()).toEqual({ cancelled: 0, forgotten: 0, deferred: 0 });
    // A pass still running when the next tick fires is reused, not duplicated.
    let release: (value: never[]) => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          release = resolve;
        }),
    );
    const overlapping = createDesktopRetention({
      repo: {
        expired: slow,
        transition: vi.fn(async () => true),
        forget: vi.fn(async () => true),
      },
      storageForIdentity: async () => createMemoryStorage({}),
      clock: () => new Date(),
      eventLog,
    });
    overlapping.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(slow).toHaveBeenCalledTimes(1);
    release([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(slow).toHaveBeenCalledTimes(2);
    // Stopping during a pass ends it after the current operation.
    const stopping = createDesktopRetention({
      repo: {
        expired: vi.fn(async () => [
          { id: randomUUID(), identityId: "a", accountId: "b", state: "conflict" } as never,
          { id: randomUUID(), identityId: "a", accountId: "b", state: "conflict" } as never,
        ]),
        transition: vi.fn(async () => {
          void stopping.stop();
          return true;
        }),
        forget: vi.fn(async () => true),
      },
      storageForIdentity: async () => createMemoryStorage({}),
      clock: () => new Date(),
      eventLog,
    });
    expect(await stopping.sweep()).toEqual({ cancelled: 1, forgotten: 0, deferred: 0 });
  } finally {
    vi.useRealTimers();
  }
});

it("removes everything one operation staged and nothing else", async () => {
  const identity = randomUUID();
  const operation = randomUUID();
  const other = randomUUID();
  const incoming = `/.fdrive-desktop/${identity}/incoming`;
  const storage = createMemoryStorage({
    [`${incoming}/${operation}/${randomUUID()}`]: "body",
    [`${incoming}/${other}/${randomUUID()}`]: "another operation's body",
    "/keep.txt": "user data",
  });
  await storage.mkdir(`${incoming}/${operation}/${randomUUID()}`);
  await removeIncoming(storage, identity, operation);
  // Nothing there is nothing to do.
  await removeIncoming(storage, identity, operation);
  await removeIncoming(storage, randomUUID(), operation);
  expect((await storage.list(incoming)).map((entry) => entry.name)).toEqual([other]);
  expect(await new Response((await storage.download("/keep.txt")).body).text()).toBe("user data");
  const offline = {
    ...storage,
    deleteDir: async () => {
      throw new StorageError("internal", "Storage offline");
    },
  };
  await expect(removeIncoming(offline, identity, other)).rejects.toThrow("offline");
});

it("never publishes twice when the storage call's answer is lost", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const input = await f.stage("old.txt", "complete", original);
  const move = f.raw.move.bind(f.raw);
  f.raw.move = vi.fn(async (path: string, target: string, options?: MoveOptions) => {
    await move(path, target, options);
    throw Error("connection lost after the rename");
  });
  // Disk shows it published, so the commit keeps its receipt.
  const receipt = await f.service.commit(f.principal, input.operationId);
  expect(receipt).toMatchObject({
    state: "completed",
    item: { version: { content: sha("complete") } },
  });
  expect(await f.read("/old.txt")).toBe("complete");
  expect(await f.service.commit(f.principal, input.operationId)).toEqual(receipt);
  expect(f.raw.move).toHaveBeenCalledTimes(1);
  await expect(f.service.cancel(f.principal, input.operationId)).rejects.toMatchObject({
    kind: "conflict",
  });
  // When disk cannot tell either, it stays committing for the retry to read.
  const next = await f.stage("next.txt", "next");
  const stat = f.raw.stat.bind(f.raw);
  f.raw.move = vi.fn(async () => {
    throw Error("disconnected");
  });
  f.raw.stat = vi.fn(async (path: string) => {
    if (path === "/next.txt") throw new StorageError("internal", "Disk gone");
    return stat(path);
  });
  await expect(f.service.commit(f.principal, next.operationId)).rejects.toMatchObject({
    kind: "internal",
  });
  expect((await f.service.status(f.principal, next.operationId)).state).toBe("committing");
  f.raw.move = vi.fn(move);
  f.raw.stat = stat;
  expect((await f.service.prepare(f.principal, next)).state).toBe("ready");
  expect((await f.service.commit(f.principal, next.operationId)).state).toBe("completed");
  expect(await f.read("/next.txt")).toBe("next");
});

it("leaves a write ready when its storage call publishes nothing", async () => {
  const f = await fixture();
  const input = await f.stage("new.txt", "bytes");
  const move = vi
    .spyOn(f.raw, "move")
    .mockRejectedValueOnce(new StorageError("payload_too_large", "Disk full"));
  await expect(f.service.commit(f.principal, input.operationId)).rejects.toMatchObject({
    kind: "payload_too_large",
  });
  await expect(f.raw.stat("/new.txt")).rejects.toMatchObject({ kind: "not_found" });
  expect((await f.service.status(f.principal, input.operationId)).state).toBe("ready");
  move.mockRestore();
  expect((await f.service.commit(f.principal, input.operationId)).state).toBe("completed");
  expect(await f.read("/new.txt")).toBe("bytes");
});

it("stages a body durably in the files folder and publishes it with one storage call", async () => {
  const f = await fixture();
  const upload = vi.spyOn(f.raw, "upload");
  const move = vi.spyOn(f.raw, "move");
  const created = await f.stage("new.txt", "bytes");
  const incoming = `/.fdrive-desktop/${f.principal.identityId}/incoming/${created.operationId}`;
  expect(upload).toHaveBeenCalledWith(
    expect.stringMatching(new RegExp(`^${incoming}/[0-9a-f-]{36}$`)),
    expect.anything(),
    expect.objectContaining({ durable: true, mkdirParents: true }),
  );
  await f.service.commit(f.principal, created.operationId);
  expect(move).toHaveBeenCalledWith(upload.mock.calls[0]?.[0], "/new.txt", {
    overwrite: false,
    publish: true,
  });
  const original = await f.service.stat(f.principal, "/old.txt");
  const saved = await f.stage("old.txt", "saved", original);
  await f.service.commit(f.principal, saved.operationId);
  expect(move).toHaveBeenLastCalledWith(upload.mock.calls[1]?.[0], "/old.txt", {
    overwrite: true,
    publish: true,
  });
  // A staged body that is gone is asked for again.
  const lost = await f.stage("lost.txt", "lost");
  await f.raw.deleteDir(`/.fdrive-desktop/${f.principal.identityId}/incoming/${lost.operationId}`);
  expect((await f.service.commit(f.principal, lost.operationId)).state).toBe("receiving");
  await f.service.upload(f.principal, lost.operationId, body("lost"), new AbortController().signal);
  expect((await f.service.commit(f.principal, lost.operationId)).state).toBe("completed");
  expect(await f.read("/lost.txt")).toBe("lost");
});

it("leaves the original untouched when the body cannot be staged", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const request = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    itemId: original.id,
    name: "old.txt",
    base: { ...original.version, content: sha("old") },
    size: 3,
    sha256: sha("new"),
  };
  await f.service.prepare(f.principal, request);
  vi.spyOn(f.raw, "upload").mockRejectedValueOnce(new StorageError("forbidden", "Denied"));
  await expect(
    f.service.upload(f.principal, request.operationId, body("new"), new AbortController().signal),
  ).rejects.toMatchObject({ kind: "forbidden" });
  expect(await f.read("/old.txt")).toBe("old");
  expect((await f.service.status(f.principal, request.operationId)).state).toBe("receiving");
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
    if (original.kind === "file")
      // Paths in and outside Trash are answered together, in the order asked.
      expect(
        (
          await f.service.files.versions(
            f.principal,
            [contentPath, "/folder/child"],
            new AbortController().signal,
          )
        ).items,
      ).toEqual([
        { path: contentPath, size: 3, version: sha("old") },
        { path: "/folder/child", size: 5, version: sha("child") },
      ]);
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

it("refuses invalid parents and replacement of directories", async () => {
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
  vi.spyOn(f.repo, "reserve").mockRejectedValueOnce(Error("database unavailable"));
  await expect(
    f.service.prepare(f.principal, { ...folder, operationId: randomUUID(), parentId: "root" }),
  ).rejects.toThrow("database unavailable");
});

it("preserves the source when its base cannot be read in full", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const input = await f.stage("old.txt", "new", original);
  const download = f.raw.download.bind(f.raw);
  f.raw.download = async (path, options) => {
    const result = await download(path, options);
    return path === "/old.txt" ? { ...result, contentLength: 999 } : result;
  };
  await expect(f.service.commit(f.principal, input.operationId)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  expect(await f.read("/old.txt")).toBe("old");
  expect((await f.service.status(f.principal, input.operationId)).state).toBe("ready");
});

it("commits a combined save and rename, and keeps an old name written meanwhile", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const input = await f.stage("renamed.txt", "new", original);
  const result = await f.service.commit(f.principal, input.operationId);
  expect(result.item?.id).toBe(original.id);
  expect(await f.read("/renamed.txt")).toBe("new");
  await expect(f.raw.stat("/old.txt")).rejects.toMatchObject({ kind: "not_found" });
  // Someone writes the old name once the new one is published: it stays.
  await f.raw.upload("/old.txt", body("old"));
  const again = await f.service.stat(f.principal, "/old.txt");
  const warn = vi.fn();
  const service = createDesktopWrites({ ...f.deps, logger: { warn } });
  const second = await f.stage("other.txt", "newer", again);
  const move = f.raw.move.bind(f.raw);
  vi.spyOn(f.raw, "move").mockImplementation(async (path, target, options) => {
    await move(path, target, options);
    if (target === "/other.txt")
      await f.raw.upload("/old.txt", body("theirs"), { overwrite: true });
  });
  expect((await service.commit(f.principal, second.operationId)).state).toBe("completed");
  expect(await f.read("/other.txt")).toBe("newer");
  expect(await f.read("/old.txt")).toBe("theirs");
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: second.operationId }),
    expect.stringContaining("old name stays"),
  );
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

it("serializes duplicate commits and never reports a lost receipt as success", async () => {
  const f = await fixture();
  const request = await f.stage("new", "abc");
  const results = await Promise.all([
    f.service.commit(f.principal, request.operationId),
    f.service.commit(f.principal, request.operationId),
  ]);
  expect(results[0]).toMatchObject({ state: "completed" });
  expect(results[1]).toEqual(results[0]);
  expect(await f.read("/new")).toBe("abc");
  const second = await f.stage("receipt-lost", "def");
  const transition = f.repo.transition.bind(f.repo);
  const lost = vi
    .spyOn(f.repo, "transition")
    .mockImplementation(async (...args) => (args[4] === "completed" ? false : transition(...args)));
  await expect(f.service.commit(f.principal, second.operationId)).rejects.toMatchObject({
    kind: "internal",
  });
  expect(await f.read("/receipt-lost")).toBe("def");
  expect((await f.service.status(f.principal, second.operationId)).state).toBe("committing");
  lost.mockRestore();
  expect((await f.service.commit(f.principal, second.operationId)).state).toBe("completed");
});

it("stages nothing through a substituted folder and needs the upload's receipt", async () => {
  const f = await fixture();
  // The files folder refuses to create the staging folder through a file.
  const home = await mkdtemp(join(tmpdir(), "desktop-home-"));
  temporary.push(home);
  const local = { ...f.principal, storage: createLocalStorage({ home }) };
  await local.storage.upload("/saved.txt", new TextEncoder().encode("old"));
  await local.storage.upload("/.fdrive-desktop", new Uint8Array());
  const original = await f.service.stat(local, "/saved.txt");
  const request = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    itemId: original.id,
    name: "saved.txt",
    base: { ...original.version, content: sha("old") },
    size: 3,
    sha256: sha("abc"),
  };
  await f.service.prepare(local, request);
  await expect(
    f.service.upload(local, request.operationId, body("abc"), new AbortController().signal),
  ).rejects.toThrow();
  expect(await new Response((await local.storage.download("/saved.txt")).body).text()).toBe("old");
  expect((await f.service.status(local, request.operationId)).state).toBe("receiving");
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
  const stat = f.storage.stat.bind(f.storage);
  const denied = vi
    .spyOn(f.storage, "stat")
    .mockRejectedValueOnce(new StorageError("upstream_unavailable", "Offline"));
  await expect(f.service.list(f.principal, DESKTOP_TRASH, "token")).rejects.toThrow("Offline");
  denied.mockImplementation(async (path) => {
    if (path.endsWith(`/${original.id}`)) throw new StorageError("forbidden", "a link");
    return stat(path);
  });
  await expect(f.service.stat(f.principal, result.path)).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect((await f.service.list(f.principal, DESKTOP_TRASH, "token")).entries).toEqual([]);
  vi.spyOn(f.repo, "children").mockResolvedValueOnce(Array(100_001).fill({}));
  await expect(f.service.list(f.principal, DESKTOP_TRASH, "token")).rejects.toMatchObject({
    kind: "rate_limited",
  });
});

it("registers a listing in one call and never returns ids its own registration retired", async () => {
  const f = await fixture();
  // A folder last seen as a file must be replaced before its children are matched.
  const stale = await f.repo.ensure(f.principal.identityId, "/folder", "file");
  const ensureMany = vi.spyOn(f.repo, "ensureMany");
  const [child] = (await f.service.list(f.principal, "/folder", "token")).entries;
  expect(ensureMany).toHaveBeenCalledTimes(1);
  const folder = required(await f.repo.at(f.principal.identityId, "/folder"));
  expect(folder.id).not.toBe(stale.id);
  expect(child?.parentId).toBe(folder.id);
  expect(await f.repo.item(f.principal.identityId, required(child).id)).not.toBeNull();
  expect((await f.service.list(f.principal, "/folder", "token")).entries).toEqual([child]);
  ensureMany.mockClear();
  expect((await f.service.list(f.principal, "/", "token")).entries.map((e) => e.path)).toEqual([
    "/folder",
    "/old.txt",
  ]);
  expect(ensureMany).toHaveBeenCalledTimes(1);
});

it("reads each Trash entry with one stat and lists no ancestors", async () => {
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
        content: path === "/old.txt" ? sha("old") : original.version.content,
      },
    };
    await f.service.prepare(f.principal, move);
    await f.service.commit(f.principal, move.operationId);
  }
  const list = vi.spyOn(f.storage, "list");
  const stat = vi.spyOn(f.storage, "stat");
  const trashed = (await f.service.list(f.principal, DESKTOP_TRASH, "token")).entries;
  expect(trashed).toHaveLength(2);
  expect(list).not.toHaveBeenCalled();
  expect(stat).toHaveBeenCalledTimes(2);
  list.mockClear();
  stat.mockClear();
  const folder = required(trashed.find((entry) => entry.kind === "dir"));
  expect((await f.service.list(f.principal, folder.path, "token")).entries).toHaveLength(1);
  // The folder itself, then its one child.
  const physical = `/.fdrive-desktop/${f.principal.identityId}/trash/${folder.id}`;
  expect(list.mock.calls).toEqual([[physical]]);
  expect(stat.mock.calls).toEqual([[physical], [`${physical}/child`]]);
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
  expect(await staged(f, request.operationId)).toEqual([]);
  await f.service.upload(
    f.principal,
    request.operationId,
    body("abc"),
    new AbortController().signal,
  );
  await f.service.commit(f.principal, request.operationId);
  expect(await f.read("/new")).toBe("abc");
});

it("keeps a staged body while the database cannot say whose it is", async () => {
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
    if (args[4] === "ready" || args[4] === "receiving") throw Error("Database unavailable");
    return transition(...args);
  });
  await expect(
    f.service.upload(f.principal, request.operationId, body("abc"), new AbortController().signal),
  ).rejects.toThrow("Database unavailable");
  expect(await staged(f, request.operationId)).toHaveLength(1);
  expect(await f.read("/old.txt")).toBe("old");
});

it("rechecks source grants and metadata at commit and forbids editing recovery entries", async () => {
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
  // Any registry update gives the item new metadata.
  await f.repo.update(f.principal.identityId, source.id, { kind: "file" });
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

it("keeps the staged body when a commit stops before publishing, and removes it once published", async () => {
  const f = await fixture();
  const source = await f.service.stat(f.principal, "/old.txt");
  const request = await f.stage("old.txt", "new", source);
  const stamp = required(f.raw.contentStamp).bind(f.raw);
  let reads = 0;
  vi.spyOn(f.raw, "contentStamp").mockImplementation(async (path) => {
    // The second read is the one right before the rename.
    if (++reads === 2) throw new StorageError("internal", "Disconnected before the rename");
    return stamp(path);
  });
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toThrow("Disconnected");
  const receipt = required(
    (await f.repo.operation(f.principal.identityId, f.principal.accountId, request.operationId))
      ?.result,
  );
  expect(await staged(f, request.operationId)).toEqual([receipt.uploadFile]);
  expect(receipt.publication).toBeUndefined();
  expect(await f.read("/old.txt")).toBe("old");
  expect((await f.service.status(f.principal, request.operationId)).state).toBe("ready");
  const result = await f.service.commit(f.principal, request.operationId);
  expect(result.state).toBe("completed");
  expect(await f.read("/old.txt")).toBe("new");
  expect(await staged(f, request.operationId)).toEqual([]);
  // Replaying prepare after a later rename must still return the original receipt.
  await f.raw.move("/old.txt", "/later");
  await f.repo.move(f.principal.identityId, "/old.txt", "/later");
  expect(await f.service.prepare(f.principal, request)).toEqual(result);
});

it("publishes nothing from a staged entry that is not a file, or without recording it first", async () => {
  for (const fault of ["entry", "record"] as const) {
    const f = await fixture();
    const source = await f.service.stat(f.principal, "/old.txt");
    const request = await f.stage("old.txt", "new", source);
    if (fault === "record") {
      const transition = f.repo.transition.bind(f.repo);
      vi.spyOn(f.repo, "transition").mockImplementation(async (...args) =>
        args[3] === "committing" && args[4] === "committing" ? false : transition(...args),
      );
    } else {
      const attempt = randomUUID();
      await f.raw.mkdir(
        `/.fdrive-desktop/${f.principal.identityId}/incoming/${request.operationId}/${attempt}`,
        { parents: true },
      );
      const operation = required(f.operations.get(f.principal.identityId + request.operationId));
      operation.result = { ...operation.result, uploadFile: attempt };
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
  // Wait for the first receiver's attempt to be the operation's, not elapsed time.
  await vi.waitFor(async () =>
    expect((await f.service.status(f.principal, input.operationId)).state).toBe("uploading"),
  );
  const second = createDesktopWrites(f.deps);
  await second.upload(f.principal, input.operationId, body("abc"), new AbortController().signal);
  required(sink).enqueue(new TextEncoder().encode("abc"));
  required(sink).close();
  await rejected;
  // Only the body the operation names stays staged.
  expect(await staged(f, input.operationId)).toEqual([
    required(f.operations.get(f.principal.identityId + input.operationId)?.result).uploadFile,
  ]);
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

it("moves metadata with a Mac move once", async () => {
  const f = await fixture();
  const item = await f.service.stat(f.principal, "/old.txt");
  const folder = await f.service.stat(f.principal, "/folder");
  const operationId = randomUUID();
  await f.service.prepare(f.principal, {
    kind: "move",
    operationId,
    itemId: item.id,
    parentId: folder.id,
    name: "moved.txt",
    base: item.version,
  });
  await f.service.commit(f.principal, operationId);
  // Links and shares move with the receipt; the rest right after it.
  expect(f.moved.get(operationId)).toEqual({
    directory: false,
    shares: { identityId: f.principal.identityId, from: "/old.txt", to: "/folder/moved.txt" },
    grants: null,
  });
  expect(f.metadata.onMoved.mock.calls).toEqual([
    [f.principal.identityId, "/old.txt", "/folder/moved.txt", false],
  ]);
  // A replayed commit returns its receipt without applying anything again.
  await f.service.commit(f.principal, operationId);
  expect(f.access).toHaveBeenCalledTimes(1);
  expect(f.metadata.onMoved).toHaveBeenCalledTimes(1);
});

it("keeps an item's handle in the Mac's Trash, and what is kept by path follows it in and back out", async () => {
  const f = await fixture();
  const { identityId } = f.principal;
  const trashRoot = `/.fdrive-desktop/${identityId}/trash`;
  const links = () => [...f.moved.values()].at(-1)?.shares;
  const move = async (item: DesktopWriteEntry, parentId: string, name = item.name) => {
    const operationId = randomUUID();
    await f.service.prepare(f.principal, {
      kind: "move",
      operationId,
      itemId: item.id,
      parentId,
      name,
      base: item.version,
    });
    return required((await f.service.commit(f.principal, operationId)).item);
  };
  const file = await f.service.stat(f.principal, "/old.txt");
  const trashed = await move(file, "trash");
  expect(trashed).toMatchObject({ id: file.id, parentId: "trash", trashed: true });
  // What grants access follows the item into the Mac's Trash, the rest after it; its handle is kept.
  expect(links()).toEqual({ identityId, from: "/old.txt", to: `${trashRoot}/${file.id}` });
  expect(f.metadata.onMoved.mock.calls).toEqual([
    [identityId, "/old.txt", `${trashRoot}/${file.id}`, false],
  ]);
  expect(required(await f.repo.item(identityId, file.id))).toMatchObject({
    path: `${trashRoot}/${file.id}`,
    originalPath: "/old.txt",
  });
  // Put back under its own name: what followed it comes back with it.
  const back = await move(trashed, "root");
  expect(back).toMatchObject({ id: file.id, path: "/old.txt", trashed: false });
  expect(links()).toEqual({ identityId, from: `${trashRoot}/${file.id}`, to: "/old.txt" });
  expect(f.metadata.onMoved).toHaveBeenLastCalledWith(
    identityId,
    `${trashRoot}/${file.id}`,
    "/old.txt",
    false,
  );
  expect([...f.completed.values()].at(-1)).toMatchObject({
    from: "/old.txt",
    to: "/old.txt",
    restored: true,
    trash: false,
  });
  // Put back under a new name: it all follows there.
  const again = await move(await f.service.stat(f.principal, "/old.txt"), "trash");
  await move(again, "root", "renamed.txt");
  expect(links()).toEqual({ identityId, from: `${trashRoot}/${file.id}`, to: "/renamed.txt" });
  expect(f.metadata.onMoved).toHaveBeenLastCalledWith(
    identityId,
    `${trashRoot}/${file.id}`,
    "/renamed.txt",
    false,
  );
});

it("restores into a folder that took the item's place without taking that folder's metadata", async () => {
  const f = await fixture();
  const { identityId } = f.principal;
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
  const restored = await f.service.commit(f.principal, restoreId);
  expect(restored.item).toMatchObject({ path: "/folder/nested", trashed: false });
  expect(await f.read("/folder/nested/child")).toBe("child");
  // `/folder` is someone else now, so only what followed the item into Trash comes back.
  const binned = `/.fdrive-desktop/${identityId}/trash/${source.id}`;
  expect(f.moved.get(restoreId)).toEqual({
    directory: true,
    shares: { identityId, from: binned, to: "/folder/nested" },
    grants: null,
  });
  expect(f.metadata.onMoved.mock.calls).toEqual([
    [identityId, "/folder", binned, true],
    [identityId, binned, "/folder/nested", true],
  ]);
});

it("never reports success when the receipt cannot be kept, and the app's retry keeps it", async () => {
  const f = await fixture();
  const { identityId } = f.principal;
  const item = await f.service.stat(f.principal, "/old.txt");
  const move = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: item.id,
    parentId: "root",
    name: "renamed.txt",
    base: item.version,
  };
  await f.service.prepare(f.principal, move);
  // The receipt's transaction fails on the links: nothing of it is kept.
  const complete = vi.spyOn(f.repo, "complete").mockRejectedValueOnce(Error("links unavailable"));
  await expect(f.service.commit(f.principal, move.operationId)).rejects.toMatchObject({
    kind: "internal",
  });
  expect(await f.read("/renamed.txt")).toBe("old");
  expect((await f.service.status(f.principal, move.operationId)).state).toBe("committing");
  expect(f.moved.has(move.operationId)).toBe(false);
  // The rest of the metadata waits for the receipt too.
  expect(f.metadata.onMoved).not.toHaveBeenCalled();
  await expect(f.service.cancel(f.principal, move.operationId)).rejects.toMatchObject({
    kind: "conflict",
  });
  // The retry keeps it, moving them from where the item was, though its handle moved already.
  complete.mockRestore();
  expect(await f.service.prepare(f.principal, move)).toMatchObject({
    state: "completed",
    item: { path: "/renamed.txt" },
  });
  expect(f.moved.get(move.operationId)?.shares).toEqual({
    identityId,
    from: "/old.txt",
    to: "/renamed.txt",
  });
  expect(f.metadata.onMoved).toHaveBeenCalledTimes(1);
});

it("never refuses a new Mac write over earlier metadata, which cannot fail a published one", async () => {
  const f = await fixture();
  const warn = vi.fn();
  const service = createDesktopWrites({ ...f.deps, logger: { warn } });
  const item = await f.service.stat(f.principal, "/old.txt");
  const operationId = randomUUID();
  await service.prepare(f.principal, {
    kind: "move",
    operationId,
    itemId: item.id,
    parentId: "root",
    name: "renamed.txt",
    base: item.version,
  });
  f.metadata.onMoved.mockRejectedValueOnce(Error("database unavailable"));
  const receipt = await service.commit(f.principal, operationId);
  expect(receipt).toMatchObject({ state: "completed", item: { path: "/renamed.txt" } });
  // Failing tags never hold back what grants access, which moved with the receipt.
  expect(f.moved.get(operationId)?.shares).toEqual({
    identityId: f.principal.identityId,
    from: "/old.txt",
    to: "/renamed.txt",
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ identityId: f.principal.identityId, operationId }),
    expect.stringContaining("could not follow"),
  );
  // A replay returns the same receipt.
  expect(await service.commit(f.principal, operationId)).toEqual(receipt);
  // The next write publishes at once; nothing waits on the metadata that failed.
  const next = await f.stage("next.txt", "next");
  expect((await service.commit(f.principal, next.operationId)).state).toBe("completed");
  expect(await f.read("/next.txt")).toBe("next");
});

it("reports a name the storage refused as a collision the Mac can retry under another", async () => {
  const f = await fixture();
  const request = await f.stage("fresh.txt", "bytes");
  // Storage refuses a taken name before writing anything, so the destination
  // was never touched.
  vi.spyOn(f.raw, "move").mockRejectedValueOnce(
    new StorageError("conflict", "The destination already exists"),
  );
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "conflict",
    details: { code: "name_collision" },
  });
  expect((await f.service.status(f.principal, request.operationId)).state).toBe("conflict");
  // The Mac app clears it on its own.
  expect((await f.service.cancel(f.principal, request.operationId)).state).toBe("cancelled");
  // A move and a new folder are refused the same way.
  const item = await f.service.stat(f.principal, "/old.txt");
  const move = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: item.id,
    parentId: "root",
    name: "taken.txt",
    base: item.version,
  };
  const folder = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "d",
  };
  for (const input of [move, folder]) await f.service.prepare(f.principal, input);
  vi.spyOn(f.raw, "move")
    .mockRejectedValueOnce(new StorageError("conflict", "taken"))
    .mockRejectedValueOnce(new StorageError("conflict", "taken"));
  for (const input of [move, folder]) {
    await expect(f.service.commit(f.principal, input.operationId)).rejects.toMatchObject({
      details: { code: "name_collision" },
    });
    expect((await f.service.status(f.principal, input.operationId)).state).toBe("conflict");
  }
  expect(await f.read("/old.txt")).toBe("old");
});

it("reserves the action and paths history will need before the native write starts", async () => {
  const f = await fixture();
  const identityId = f.principal.identityId;
  const trashRoot = `/.fdrive-desktop/${identityId}/trash`;
  await f.raw.mkdir("/.fdrive-desktop");
  await f.raw.mkdir(`/.fdrive-desktop/${identityId}`);
  await f.raw.mkdir(trashRoot);
  const reserved = async (operationId: string) =>
    required(await f.repo.operation(identityId, f.principal.accountId, operationId)).request;

  const folder = {
    kind: "folder" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "d",
  };
  await f.service.prepare(f.principal, folder);
  expect(await reserved(folder.operationId)).toMatchObject({
    activityAction: "folder.create",
    activityPath: "/d",
    activityTarget: "/d",
    activityKind: "dir",
  });

  const created = await f.stage("fresh.txt", "bytes");
  expect(await reserved(created.operationId)).toMatchObject({
    activityAction: "file.create",
    activityPath: "/fresh.txt",
    activityKind: "file",
  });

  const original = await f.service.stat(f.principal, "/old.txt");
  const saved = await f.stage("old.txt", "saved", original);
  expect(await reserved(saved.operationId)).toMatchObject({
    activityAction: "file.save",
    activityPath: "/old.txt",
    activityTarget: "/old.txt",
  });
  await f.service.commit(f.principal, saved.operationId);

  const renamed = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: original.id,
    parentId: "root",
    name: "renamed.txt",
    base: required((await f.service.status(f.principal, saved.operationId)).item).version,
  };
  await f.service.prepare(f.principal, renamed);
  expect(await reserved(renamed.operationId)).toMatchObject({
    activityAction: "file.rename",
    activityPath: "/old.txt",
    activityTarget: "/renamed.txt",
  });
  const afterRename = required((await f.service.commit(f.principal, renamed.operationId)).item);

  const trashed = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: original.id,
    parentId: "trash",
    name: afterRename.name,
    base: afterRename.version,
  };
  await f.service.prepare(f.principal, trashed);
  expect(await reserved(trashed.operationId)).toMatchObject({ activityAction: "file.trash" });
  const inTrash = required((await f.service.commit(f.principal, trashed.operationId)).item);

  const restore = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: original.id,
    parentId: "root",
    name: inTrash.name,
    base: inTrash.version,
  };
  await f.service.prepare(f.principal, restore);
  expect(await reserved(restore.operationId)).toMatchObject({ activityAction: "file.restore" });
  await f.service.commit(f.principal, restore.operationId);
  // The receipt says this was a restore, so history does not read it as a plain move.
  expect(f.completed.get(restore.operationId)).toMatchObject({ restored: true, trash: false });
});

const files = (parent: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `f${index}`,
    path: `${parent}/f${index}`,
    kind: "file" as const,
    size: 1,
    modifiedAt: new Date(0),
    ext: "",
  }));

it("names complete listings with a token that only their contents and access change", async () => {
  const f = await fixture();
  const first = await f.service.list(f.principal, "/", "token");
  expect(first.token).toMatch(/^v1:[0-9a-f]{64}$/);
  // Another process derives the same token from the same folder and registry.
  expect((await createDesktopWrites(f.deps).list(f.principal, "/", "token")).token).toBe(
    first.token,
  );
  await f.raw.upload("/new.txt", body("new"));
  const added = await f.service.list(f.principal, "/", "token");
  expect(added.token).not.toBe(first.token);
  const item = required(await f.repo.at(f.principal.identityId, "/new.txt"));
  await f.repo.update(f.principal.identityId, item.id, {});
  const updated = await f.service.list(f.principal, "/", "token");
  expect(updated.token).not.toBe(added.token);
  const readOnly = { ...f.principal, tokenAccess: { mode: "read" as const, paths: ["/"] } };
  expect((await f.service.list(readOnly, "/", "token")).token).not.toBe(updated.token);
  // Neither Trash nor a folder that needs more than one page carries one.
  expect((await f.service.list(f.principal, DESKTOP_TRASH, "token")).token).toBeUndefined();
  const list = f.storage.list.bind(f.storage);
  vi.spyOn(f.storage, "list").mockImplementation(async (path) =>
    path === "/folder" ? files("/folder", 501) : list(path),
  );
  const page = await f.service.list(f.principal, "/folder", "token");
  expect(page.token).toBeUndefined();
  const rest = await f.service.list(f.principal, "/folder", "token", required(page.nextCursor));
  expect(rest.nextCursor).toBeNull();
  expect(rest.token).toBeUndefined();
});

it("checks folders against their tokens without registering or relisting anything", async () => {
  const f = await fixture();
  await f.raw.mkdir("/folder/sub");
  const tokens = new Map<string, string>();
  for (const path of ["/", "/folder", "/folder/sub"])
    tokens.set(path, required((await f.service.list(f.principal, path, "token")).token));
  const ask = (...paths: string[]) =>
    paths.map((path) => ({ path, token: tokens.get(path) ?? "v1:other" }));
  const signal = new AbortController().signal;
  const list = vi.spyOn(f.storage, "list");
  const ensureMany = vi.spyOn(f.repo, "ensureMany");
  expect(await f.service.check(f.principal, ask("/folder/sub", "/", "/folder"), signal)).toEqual({
    folders: [
      { path: "/folder/sub", status: "unchanged" },
      { path: "/", status: "unchanged" },
      { path: "/folder", status: "unchanged" },
    ],
  });
  // Each folder is read upstream once, and none of its ancestors is.
  expect(list.mock.calls.map(([path]) => path)).toEqual(["/folder/sub", "/", "/folder"]);
  // Changed content and unregistered entries both read as changed, and stay unregistered.
  await f.raw.upload("/folder/child", body("changed"), { overwrite: true });
  await f.raw.upload("/folder/sub/new.txt", body("new"));
  expect(
    (await f.service.check(f.principal, ask("/folder", "/folder/sub"), signal)).folders,
  ).toEqual([
    { path: "/folder", status: "changed" },
    { path: "/folder/sub", status: "changed" },
  ]);
  expect(await f.repo.at(f.principal.identityId, "/folder/sub/new.txt")).toBeNull();
  expect(ensureMany).not.toHaveBeenCalled();
  // A folder whose registry row is gone is listed again.
  await f.repo.remove(f.principal.identityId, "/folder/sub");
  expect((await f.service.check(f.principal, ask("/folder/sub"), signal)).folders).toEqual([
    { path: "/folder/sub", status: "changed" },
  ]);
  expect(
    (
      await f.service.check(
        f.principal,
        ["/", "/old.txt", "/gone", "/.fdrive-desktop/x"].map((path) => ({ path, token: "v1:x" })),
        signal,
      )
    ).folders,
  ).toEqual([
    { path: "/", status: "changed" },
    { path: "/old.txt", status: "missing" },
    { path: "/gone", status: "missing" },
    { path: "/.fdrive-desktop/x", status: "forbidden" },
  ]);
  // Trash is always relisted, without touching storage.
  list.mockClear();
  expect(
    (
      await f.service.check(
        f.principal,
        [DESKTOP_TRASH, `${DESKTOP_TRASH}/item`].map((path) => ({ path, token: "v1:x" })),
        signal,
      )
    ).folders.map((folder) => folder.status),
  ).toEqual(["changed", "changed"]);
  expect(list).not.toHaveBeenCalled();
});

it("bounds folder checks by size and access, and fails on upstream outages", async () => {
  const f = await fixture();
  const tokens = new Map<string, string>();
  for (const path of ["/", "/folder"])
    tokens.set(path, required((await f.service.list(f.principal, path, "token")).token));
  const ask = (...paths: string[]) =>
    paths.map((path) => ({ path, token: tokens.get(path) ?? "v1:other" }));
  const signal = new AbortController().signal;
  const list = f.storage.list.bind(f.storage);
  const spy = vi.spyOn(f.storage, "list");
  spy.mockImplementation(async (path) => (path === "/folder" ? files("/folder", 501) : list(path)));
  expect((await f.service.check(f.principal, ask("/folder"), signal)).folders).toEqual([
    { path: "/folder", status: "changed" },
  ]);
  const stat = f.storage.stat.bind(f.storage);
  const link = vi.spyOn(f.storage, "stat").mockImplementation(async (path) => {
    if (path === "/folder") throw new StorageError("forbidden", "a link");
    return stat(path);
  });
  expect((await f.service.check(f.principal, ask("/folder"), signal)).folders).toEqual([
    { path: "/folder", status: "forbidden" },
  ]);
  link.mockRestore();
  spy.mockRejectedValue(new StorageError("upstream_unavailable", "Offline"));
  await expect(f.service.check(f.principal, ask("/folder"), signal)).rejects.toThrow("Offline");
  spy.mockImplementation(list);
  // Every folder asked about is answered, however many there are.
  expect((await f.service.check(f.principal, ask("/", "/folder"), signal)).folders).toEqual([
    { path: "/", status: "unchanged" },
    { path: "/folder", status: "unchanged" },
  ]);
  const aborted = new AbortController();
  aborted.abort();
  await expect(f.service.check(f.principal, ask("/"), aborted.signal)).rejects.toThrow();
});

it("answers a retry that comes while the commit runs with that commit's outcome", async () => {
  const f = await fixture();
  const original = await f.service.stat(f.principal, "/old.txt");
  const save = await f.stage("old.txt", "saved", original);
  const move = f.raw.move.bind(f.raw);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = crashAt();
  f.raw.move = vi.fn(async (path: string, target: string, options?: MoveOptions) => {
    void reached.call();
    await held;
    await move(path, target, options);
  });
  const commit = f.service.commit(f.principal, save.operationId);
  await reached.made;
  // The app's request timed out and it retries: the retry waits instead of
  // reading a publication still under way.
  const retry = f.service.prepare(f.principal, save);
  release();
  const [committed, retried] = await Promise.all([commit, retry]);
  expect(retried).toEqual(committed);
  expect(committed).toMatchObject({ state: "completed" });
  expect(f.raw.move).toHaveBeenCalledTimes(1);
  // A commit that stopped before it recorded anything is simply ready again.
  const next = await f.stage("next.txt", "next");
  const key = f.principal.identityId + next.operationId;
  f.operations.set(key, { ...required(f.operations.get(key)), state: "committing" });
  expect((await f.service.prepare(f.principal, next)).state).toBe("ready");
  expect((await f.service.commit(f.principal, next.operationId)).state).toBe("completed");
});

it("returns the receipt another settlement kept first, and makes a lost publication a conflict", async () => {
  const f = await fixture();
  const created = await f.stage("new.txt", "bytes");
  const complete = f.repo.complete.bind(f.repo);
  vi.spyOn(f.repo, "complete").mockImplementationOnce(async (...args) => {
    await complete(...args);
    return false;
  });
  const receipt = await f.service.commit(f.principal, created.operationId);
  expect(receipt).toMatchObject({ state: "completed", item: { path: "/new.txt" } });
  expect(await f.service.status(f.principal, created.operationId)).toEqual(receipt);
  // The storage call fails, and by then the staged body has gone elsewhere:
  // neither end holds it, so nothing is published over anything.
  const lost = await f.stage("lost.txt", "lost");
  const move = f.raw.move.bind(f.raw);
  f.raw.move = vi.fn(async (path: string) => {
    await move(path, "/somewhere-else.txt");
    throw Error("disconnected");
  });
  await expect(f.service.commit(f.principal, lost.operationId)).rejects.toMatchObject({
    details: { code: "version_conflict" },
  });
  expect((await f.service.status(f.principal, lost.operationId)).state).toBe("conflict");
  expect(f.raw.dump()["/lost.txt"]).toBeUndefined();
});
