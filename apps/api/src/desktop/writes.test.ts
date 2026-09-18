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
import { createDesktopRetention, removeRecoveryTree } from "./retention.js";
import {
  createDesktopWrites,
  DESKTOP_COMMIT_STALL_MS,
  DESKTOP_TRASH,
  NO_WRITES,
} from "./writes.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ALL_WRITES = { create: true, update: true, move: true, trash: true, restore: true };
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

it("reclaims expired uploads, stale conflicts and old backups only inside the recovery namespace", async () => {
  const f = await fixture();
  const eventLog = { record: vi.fn() };
  let now = new Date();
  const retention = createDesktopRetention({
    repo: f.repo,
    stateDir: f.stateDir,
    storageForIdentity: async () => f.storage,
    clock: () => now,
    eventLog,
  });
  const key = (id: string) => f.principal.identityId + id;
  // An acknowledged replacement leaves a retained original under the recovery namespace.
  const original = await f.service.stat(f.principal, "/old.txt");
  const replaced = await f.stage("old.txt", "new", original);
  await f.service.commit(f.principal, replaced.operationId);
  await f.service.acknowledge(f.principal, replaced.operationId);
  const internal = `/.fdrive-desktop/${f.principal.identityId}/${replaced.operationId}`;
  const attempts = await f.raw.list(internal);
  expect(attempts.map((entry) => entry.kind)).toEqual(["dir"]);
  expect((await f.raw.list(required(attempts[0]).path)).map((entry) => entry.name)).toEqual([
    "previous",
  ]);
  // A body that never finished, a conflict nobody retried, and a tree with a stray entry.
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
  const stray = await f.stage("stray.txt", "stray");
  await f.service.commit(f.principal, stray.operationId);
  await f.service.acknowledge(f.principal, stray.operationId);
  const strayInternal = `/.fdrive-desktop/${f.principal.identityId}/${stray.operationId}`;
  await f.raw.upload(`${strayInternal}/notes.txt`, body("someone else's file"));
  // An uncertain commit is never a candidate, however old.
  const uncertain = await f.stage("uncertain.txt", "uncertain");
  f.operations.set(key(uncertain.operationId), {
    ...required(f.operations.get(key(uncertain.operationId))),
    state: "uncertain",
  });
  expect(await retention.sweep()).toEqual({ cancelled: 0, reclaimed: 0, deferred: 0 });
  now = new Date(now.getTime() + 31 * 24 * 60 * 60_000);
  expect(await retention.sweep()).toEqual({ cancelled: 2, reclaimed: 1, deferred: 1 });
  expect((await f.service.status(f.principal, idle.operationId)).state).toBe("cancelled");
  expect((await f.service.status(f.principal, conflicted.operationId)).state).toBe("cancelled");
  expect(await readdir(join(f.stateDir, f.principal.identityId))).not.toContain(idle.operationId);
  expect(
    (await f.raw.list(`/.fdrive-desktop/${f.principal.identityId}`)).map((e) => e.path),
  ).toEqual([strayInternal]);
  expect(required(f.operations.get(key(replaced.operationId))).result?.reclaimedAt).toBeTruthy();
  expect(required(f.operations.get(key(stray.operationId))).result?.reclaimedAt).toBeUndefined();
  expect(eventLog.record).toHaveBeenCalledWith(
    "general",
    "warn",
    "Mac write recovery reclamation deferred",
    expect.objectContaining({ operationId: stray.operationId }),
  );
  expect((await f.service.status(f.principal, uncertain.operationId)).state).toBe("uncertain");
  expect(await f.read("/old.txt")).toBe("new");
  expect(await f.read("/stray.txt")).toBe("stray");
  // Cancelled rows are reclaimed by a later pass; a second pass changes nothing else.
  expect(await retention.sweep()).toEqual({ cancelled: 0, reclaimed: 2, deferred: 1 });
  expect(await retention.sweep()).toEqual({ cancelled: 0, reclaimed: 0, deferred: 1 });
  expect(f.storage.withWriteLease).toHaveBeenCalled();
  // Without a spool directory or a lease-capable provider the same rules apply.
  const bare = createDesktopRetention({
    repo: f.repo,
    storageForIdentity: async () => f.raw,
    clock: () => now,
    eventLog,
  });
  const late = await f.stage("late.txt", "late");
  f.operations.set(key(late.operationId), {
    ...required(f.operations.get(key(late.operationId))),
    state: "receiving",
    updatedAt: new Date(0),
  });
  expect(await bare.sweep()).toEqual({ cancelled: 1, reclaimed: 0, deferred: 1 });
  expect((await f.service.status(f.principal, late.operationId)).state).toBe("cancelled");
});

it("resolves an uncertain commit from storage evidence without replaying the write", async () => {
  const f = await fixture();
  const eventLog = { record: vi.fn() };
  const service = createDesktopWrites({ ...f.deps, storageForIdentity: async () => f.storage });
  void eventLog;
  const now = () => new Date();
  const original = await service.stat(f.principal, "/old.txt");
  const input = await f.stage("old.txt", "published", original);
  const move = f.raw.move.bind(f.raw);
  f.raw.move = vi.fn(async (path: string, target: string, options?: { overwrite?: boolean }) => {
    await move(path, target, options);
    throw Error("connection lost after commit");
  });
  await expect(service.commit(f.principal, input.operationId)).rejects.toMatchObject({
    details: { code: "operation_uncertain" },
  });
  const { identityId, accountId } = f.principal;
  expect(await service.uncertain(now())).toMatchObject([
    { operationId: input.operationId, state: "uncertain", stalled: true, kind: "upload" },
  ]);
  // A live commit is not resolvable; a stalled one is.
  const live = await f.stage("live.txt", "live");
  f.operations.set(identityId + live.operationId, {
    ...required(f.operations.get(identityId + live.operationId)),
    state: "committing",
  });
  await expect(
    service.resolve(identityId, accountId, live.operationId, "discarded", now()),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(
    (
      await service.resolve(
        identityId,
        accountId,
        live.operationId,
        "discarded",
        new Date(Date.now() + DESKTOP_COMMIT_STALL_MS + 1),
      )
    ).state,
  ).toBe("cancelled");
  // Wrong evidence is refused before any registry change; resolution never moves bytes.
  f.raw.move = vi.fn(move);
  const other = await f.stage("other.txt", "other");
  f.operations.set(identityId + other.operationId, {
    ...required(f.operations.get(identityId + other.operationId)),
    state: "uncertain",
  });
  await expect(
    service.resolve(identityId, accountId, other.operationId, "published", now()),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(await f.read("/old.txt")).toBe("published");
  const resolved = await service.resolve(
    identityId,
    accountId,
    input.operationId,
    "published",
    now(),
  );
  expect(resolved).toMatchObject({
    state: "completed",
    recoveryId: input.operationId,
    item: { path: "/old.txt", version: { content: sha("published") } },
  });
  expect(await f.read("/old.txt")).toBe("published");
  expect((await service.status(f.principal, input.operationId)).state).toBe("completed");
  expect(await service.acknowledge(f.principal, input.operationId)).toMatchObject({
    state: "completed",
  });
  expect(f.raw.move).toHaveBeenCalledTimes(0);
  await expect(
    service.resolve(identityId, accountId, input.operationId, "published", now()),
  ).rejects.toMatchObject({ kind: "conflict" });
});

it("resolves trash moves and restores, and refuses missing sources or unavailable storage", async () => {
  const f = await fixture();
  const { identityId, accountId } = f.principal;
  const key = (id: string) => identityId + id;
  const now = () => new Date();
  const markUncertain = (id: string) =>
    f.operations.set(key(id), { ...required(f.operations.get(key(id))), state: "uncertain" });
  const original = await f.service.stat(f.principal, "/old.txt");
  const stale = await f.stage("old.txt", "stale", original);
  markUncertain(stale.operationId);
  await expect(
    f.service.resolve(identityId, accountId, stale.operationId, "published", now()),
  ).rejects.toMatchObject({ kind: "upstream_unavailable" });
  const { effectContext: _unused, ...bare } = f.deps;
  const service = createDesktopWrites({
    ...bare,
    storageForIdentity: async () => f.storage,
    effects: {
      beforeWrite: async () => undefined,
      kick: () => {
        throw Error("kick failed");
      },
    },
  });
  // An upload whose target is a folder is not evidence of publication.
  const folder = await f.stage("folder", "bytes");
  markUncertain(folder.operationId);
  await expect(
    service.resolve(identityId, accountId, folder.operationId, "published", now()),
  ).rejects.toMatchObject({ kind: "conflict" });
  // A trash move whose storage step completed but whose registry update was lost.
  const trashed = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: original.id,
    parentId: "trash",
    name: original.name,
    base: original.version,
  };
  await service.prepare(f.principal, trashed);
  const trashRoot = `/.fdrive-desktop/${identityId}/trash`;
  await f.raw.mkdir("/.fdrive-desktop");
  await f.raw.mkdir(`/.fdrive-desktop/${identityId}`);
  await f.raw.mkdir(trashRoot);
  markUncertain(trashed.operationId);
  await expect(
    service.resolve(identityId, accountId, trashed.operationId, "published", now()),
  ).rejects.toMatchObject({ kind: "conflict" });
  await f.raw.move("/old.txt", `${trashRoot}/${original.id}`);
  const inTrash = await service.resolve(
    identityId,
    accountId,
    trashed.operationId,
    "published",
    now(),
  );
  expect(inTrash.item).toMatchObject({ trashed: true, parentId: "trash", id: original.id });
  expect(required(await f.repo.item(identityId, original.id))).toMatchObject({
    path: `${trashRoot}/${original.id}`,
    originalPath: "/old.txt",
  });
  // A restore whose storage step completed: the request carries the recovery name.
  const restore = {
    kind: "move" as const,
    operationId: randomUUID(),
    itemId: original.id,
    parentId: "root",
    name: required(inTrash.item).name,
    base: required(inTrash.item).version,
  };
  expect(restore.name).toContain("(deleted ");
  await service.prepare(f.principal, restore);
  await f.raw.move(`${trashRoot}/${original.id}`, "/old.txt");
  markUncertain(restore.operationId);
  const restored = await service.resolve(
    identityId,
    accountId,
    restore.operationId,
    "published",
    now(),
  );
  expect(restored.item).toMatchObject({ path: "/old.txt", name: "old.txt", trashed: false });
  expect(required(await f.repo.item(identityId, original.id))).toMatchObject({
    path: "/old.txt",
    originalPath: null,
  });
  // A source handle that disappeared cannot be resolved as published.
  const orphan = await f.stage("old.txt", "orphan", await service.stat(f.principal, "/old.txt"));
  markUncertain(orphan.operationId);
  f.items.delete(original.id);
  await expect(
    service.resolve(identityId, accountId, orphan.operationId, "published", now()),
  ).rejects.toMatchObject({ kind: "conflict" });
});

it("refuses resolution when evidence or the ledger changes underneath it", async () => {
  const f = await fixture();
  const { identityId, accountId } = f.principal;
  const key = (id: string) => identityId + id;
  const now = () => new Date();
  const markUncertain = (id: string) =>
    f.operations.set(key(id), { ...required(f.operations.get(key(id))), state: "uncertain" });
  const original = await f.service.stat(f.principal, "/old.txt");
  const differing = await f.stage("old.txt", "never published", original);
  markUncertain(differing.operationId);
  const service = createDesktopWrites({ ...f.deps, storageForIdentity: async () => f.storage });
  await expect(
    service.resolve(identityId, accountId, differing.operationId, "published", now()),
  ).rejects.toThrow("bytes differ");
  const list = f.raw.list.bind(f.raw);
  f.raw.list = vi.fn(async () => {
    throw new StorageError("upstream_unavailable", "Storage offline");
  });
  await expect(
    service.resolve(identityId, accountId, differing.operationId, "published", now()),
  ).rejects.toMatchObject({ kind: "upstream_unavailable" });
  f.raw.list = list;
  const stuck = createDesktopWrites({
    ...f.deps,
    storageForIdentity: async () => f.storage,
    repo: { ...f.repo, transition: async () => false, complete: async () => false },
  });
  await expect(
    stuck.resolve(identityId, accountId, differing.operationId, "discarded", now()),
  ).rejects.toThrow("changed while resolving");
  const published = await f.stage("fresh.txt", "fresh");
  await f.raw.upload("/fresh.txt", body("fresh"));
  markUncertain(published.operationId);
  await expect(
    stuck.resolve(identityId, accountId, published.operationId, "published", now()),
  ).rejects.toThrow("changed while resolving");
  const halfway = createDesktopWrites({
    ...f.deps,
    storageForIdentity: async () => f.storage,
    repo: { ...f.repo, complete: async () => false },
  });
  await expect(
    halfway.resolve(identityId, accountId, published.operationId, "published", now()),
  ).rejects.toThrow("changed while resolving");
  expect((await f.service.status(f.principal, published.operationId)).state).toBe("committing");
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
      repo: { expired, transition: vi.fn(async () => true), reclaim: vi.fn(async () => true) },
      storageForIdentity: async () => createMemoryStorage({}),
      clock: () => new Date(),
      eventLog,
    });
    retention.start();
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(eventLog.record).toHaveBeenCalledWith(
      "general",
      "error",
      "Mac write recovery reclamation failed",
      { error: "db down" },
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(expired).toHaveBeenCalledTimes(2);
    await retention.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(expired).toHaveBeenCalledTimes(2);
    retention.start();
    expect(await retention.sweep()).toEqual({ cancelled: 0, reclaimed: 0, deferred: 0 });
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
        reclaim: vi.fn(async () => true),
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
        reclaim: vi.fn(async () => true),
      },
      storageForIdentity: async () => createMemoryStorage({}),
      clock: () => new Date(),
      eventLog,
    });
    expect(await stopping.sweep()).toEqual({ cancelled: 1, reclaimed: 0, deferred: 0 });
  } finally {
    vi.useRealTimers();
  }
});

it("refuses to remove anything outside the expected recovery layout", async () => {
  const attempt = randomUUID();
  const base = "/.fdrive-desktop/identity";
  const storage = createMemoryStorage({
    [`${base}/valid/${attempt}/previous`]: "backup",
    [`${base}/valid/${attempt}/incoming`]: "staged",
    [`${base}/file-op`]: "not a directory",
    [`${base}/odd/notes/previous`]: "unexpected attempt name",
    [`${base}/loose/${attempt}/extra.txt`]: "unexpected file",
    [`${base}/nested/${attempt}/previous/inner`]: "unexpected directory",
    "/keep.txt": "user data",
  });
  const paths = async () => (await storage.list(base)).map((entry) => entry.path).sort();
  await removeRecoveryTree(storage, "/.fdrive-desktop/missing-identity/op");
  await removeRecoveryTree(storage, `${base}/absent`);
  const offline = {
    ...storage,
    list: async () => {
      throw new StorageError("upstream_unavailable", "Storage offline");
    },
  };
  await expect(removeRecoveryTree(offline, `${base}/valid`)).rejects.toThrow("offline");
  for (const op of ["file-op", "odd", "loose", "nested"])
    await expect(removeRecoveryTree(storage, `${base}/${op}`)).rejects.toThrow("Unexpected");
  expect(await paths()).toEqual(
    [`${base}/valid`, `${base}/file-op`, `${base}/odd`, `${base}/loose`, `${base}/nested`].sort(),
  );
  await removeRecoveryTree(storage, `${base}/valid`);
  expect(await paths()).not.toContain(`${base}/valid`);
  expect(await new Response((await storage.download("/keep.txt")).body).text()).toBe("user data");
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

it("reports every precondition a full grant is missing, and none for a read grant", async () => {
  const f = await fixture();
  const raw = createMemoryStorage({});
  const withStorage = (storage: StorageProvider): Principal => ({ ...f.principal, storage });
  expect(f.service.availability(f.principal)).toEqual({ capabilities: ALL_WRITES, missing: [] });
  expect(
    f.service.availability({ ...f.principal, tokenAccess: { mode: "read", paths: ["/"] } }),
  ).toEqual({ capabilities: NO_WRITES, missing: [] });
  // Storage without a lease waits only for fdrive's own serialization.
  expect(f.service.availability(withStorage(raw))).toEqual({
    capabilities: NO_WRITES,
    missing: ["publish_lock"],
  });
  const serialized = createDesktopWrites({
    ...f.deps,
    publishLock: async (_identityId, run) => run(),
  });
  expect(serialized.availability(withStorage(raw))).toEqual({
    capabilities: ALL_WRITES,
    missing: [],
  });
  // Without recovery storage every gate is still reported, so one fix never masks the next.
  const { stateDir: _unused, ...withoutStateDir } = f.deps;
  const unrecoverable = createDesktopWrites(withoutStateDir);
  expect(unrecoverable.availability(f.principal)).toEqual({
    capabilities: NO_WRITES,
    missing: ["state_dir"],
  });
  expect(unrecoverable.availability(withStorage(raw)).missing).toEqual([
    "state_dir",
    "publish_lock",
  ]);
  expect(unrecoverable.capabilities(f.principal)).toEqual(NO_WRITES);
});

it("refuses a file the storage could never publish, before any of it is transferred", async () => {
  const f = await fixture();
  // S3 publishes with a copy it refuses above 5 GiB, however the bytes arrived.
  const bounded: Principal = { ...f.principal, storage: { ...f.storage, maxPublishBytes: 8 } };
  const upload = vi.spyOn(f.raw, "upload");
  const request = {
    kind: "upload" as const,
    operationId: randomUUID(),
    parentId: "root",
    name: "big.bin",
    base: null,
    size: 9,
    sha256: sha("123456789"),
  };
  await expect(f.service.prepare(bounded, request)).rejects.toMatchObject({
    kind: "bad_request",
    details: { code: "quota_exceeded" },
  });
  expect(upload).not.toHaveBeenCalled();
  // The bound is the storage's, not a rejection of everything: its own size fits.
  expect(
    (await f.service.prepare(bounded, { ...request, size: 8, sha256: sha("12345678") })).state,
  ).toBe("receiving");
  // The replaced file is copied to recovery first, so it meets the same bound
  // even when the incoming one does. "/old.txt" holds three bytes.
  const tight: Principal = { ...f.principal, storage: { ...f.storage, maxPublishBytes: 2 } };
  const existing = await f.service.stat(f.principal, "/old.txt");
  await expect(
    f.service.prepare(tight, {
      ...request,
      operationId: randomUUID(),
      name: "old.txt",
      itemId: existing.id,
      base: { ...existing.version, content: sha("old") },
      size: 1,
      sha256: sha("x"),
    }),
  ).rejects.toMatchObject({ kind: "bad_request", details: { code: "quota_exceeded" } });
  expect(await f.read("/old.txt")).toBe("old");
});

it("leaves a publication the storage refused discardable rather than uncertain", async () => {
  const f = await fixture();
  const request = await f.stage("fresh.txt", "bytes");
  // Every backend evaluates `overwrite: false` before writing, so a conflict
  // here means the destination was never touched.
  vi.spyOn(f.raw, "move").mockRejectedValueOnce(
    new StorageError("conflict", "The destination already exists"),
  );
  const failure = await f.service.commit(f.principal, request.operationId).catch((e: unknown) => e);
  expect(failure).toMatchObject({ kind: "conflict" });
  expect((failure as { details?: { code?: string } }).details?.code).not.toBe(
    "operation_uncertain",
  );
  const state = (await f.service.status(f.principal, request.operationId)).state;
  expect(state).not.toBe("uncertain");
  // The Mac app clears it on its own; an uncertain commit would need an administrator.
  expect((await f.service.cancel(f.principal, request.operationId)).state).toBe("cancelled");
});

/** A storage with no rename, like S3: moving a folder copies every object. */
function copyingStorage(seed: Record<string, string>) {
  const raw = createMemoryStorage(seed);
  const moves: { path: string; resume: boolean | undefined; overwrite: boolean | undefined }[] = [];
  let fail: string | undefined;
  const storage: StorageProvider = {
    ...raw,
    movesDirectoriesByCopy: true,
    move: async (path, target, opts) => {
      moves.push({ path, resume: opts?.resume, overwrite: opts?.overwrite });
      if (fail !== undefined) {
        const message = fail;
        fail = undefined;
        // The port copies every object before removing any, so an interruption
        // leaves the source whole — nothing is mutated here.
        throw new StorageError("upstream_unavailable", message);
      }
      return raw.move(path, target, opts);
    },
  };
  return { raw, storage, moves, interrupt: (message: string) => (fail = message) };
}

it("copies a folder move outside the publication lock, and keeps a file move inside it", async () => {
  const f = await fixture();
  const { storage, raw } = copyingStorage({ "/folder/child": "child", "/note.txt": "note" });
  let held = 0;
  const heldDuring: Record<string, boolean> = {};
  const watched: StorageProvider = {
    ...storage,
    move: async (path, target, opts) => {
      heldDuring[path] = held > 0;
      return storage.move(path, target, opts);
    },
  };
  const principal: Principal = { ...f.principal, storage: watched };
  const service = createDesktopWrites({
    ...f.deps,
    publishLock: async (_identityId, run) => {
      held += 1;
      try {
        return await run();
      } finally {
        held -= 1;
      }
    },
  });
  const move = async (path: string, name: string) => {
    const item = await service.stat(principal, path);
    const operationId = randomUUID();
    await service.prepare(principal, {
      kind: "move" as const,
      operationId,
      itemId: item.id,
      parentId: "root",
      name,
      base: item.version,
    });
    return service.commit(principal, operationId);
  };
  expect((await move("/folder", "folder-moved")).state).toBe("completed");
  expect((await move("/note.txt", "note-moved.txt")).state).toBe("completed");
  expect(await new Response((await raw.download("/folder-moved/child")).body).text()).toBe("child");
  // The folder copy is proportional to the tree and the lock is per identity
  // with a 30s wait, so holding it would refuse every other Mac write meanwhile.
  expect(heldDuring["/folder"]).toBe(false);
  // A file move is one operation; it stays inside, where the checks are.
  expect(heldDuring["/note.txt"]).toBe(true);
});

it("resumes an interrupted folder move on its own destination instead of starting a second", async () => {
  const f = await fixture();
  const { storage, raw, moves, interrupt } = copyingStorage({ "/folder/child": "child" });
  const principal: Principal = { ...f.principal, storage };
  const service = createDesktopWrites({
    ...f.deps,
    publishLock: async (_identityId, run) => run(),
  });
  const item = await service.stat(principal, "/folder");
  const operationId = randomUUID();
  await service.prepare(principal, {
    kind: "move" as const,
    operationId,
    itemId: item.id,
    parentId: "root",
    name: "folder-moved",
    base: item.version,
  });
  interrupt("connection reset");
  await expect(service.commit(principal, operationId)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  // Resumable, so never an outcome only an administrator can clear.
  const failed = await service.status(principal, operationId);
  expect(failed.state).not.toBe("uncertain");
  // The retry finishes the reserved destination rather than moving beside it.
  expect((await service.commit(principal, operationId)).state).toBe("completed");
  expect(moves.map((entry) => entry.resume)).toEqual([false, true]);
  expect(await new Response((await raw.download("/folder-moved/child")).body).text()).toBe("child");
  await expect(raw.stat("/folder-moved 2")).rejects.toMatchObject({ kind: "not_found" });
});

it("completes a folder move whose last object landed before its receipt was written", async () => {
  const f = await fixture();
  const { storage, raw, moves } = copyingStorage({ "/folder/child": "child" });
  // The move itself succeeds; the receipt after it does not, which is the window
  // a crash between the last copied object and the commit record leaves behind.
  let breakReceipt = true;
  const principal: Principal = { ...f.principal, storage };
  const service = createDesktopWrites({
    ...f.deps,
    repo: {
      ...f.repo,
      complete: async (...args: Parameters<typeof f.repo.complete>) => {
        if (breakReceipt) {
          breakReceipt = false;
          throw new StorageError("upstream_unavailable", "database went away");
        }
        return f.repo.complete(...args);
      },
    },
    publishLock: async (_identityId, run) => run(),
  });
  const item = await service.stat(principal, "/folder");
  const operationId = randomUUID();
  await service.prepare(principal, {
    kind: "move" as const,
    operationId,
    itemId: item.id,
    parentId: "root",
    name: "folder-moved",
    base: item.version,
  });
  await expect(service.commit(principal, operationId)).rejects.toBeTruthy();
  // Storage is already done: the source is gone and everything is at the target.
  await expect(raw.stat("/folder")).rejects.toMatchObject({ kind: "not_found" });
  expect(await new Response((await raw.download("/folder-moved/child")).body).text()).toBe("child");
  // The retry must finish the receipt rather than fail forever on the source it
  // has itself just moved away.
  expect((await service.commit(principal, operationId)).state).toBe("completed");
  expect(moves).toHaveLength(1);
  expect((await service.stat(principal, "/folder-moved")).id).toBe(item.id);
});

it("copies nothing when the destination it needs to reserve cannot be recorded", async () => {
  const f = await fixture();
  const { storage, moves } = copyingStorage({ "/folder/child": "child" });
  const principal: Principal = { ...f.principal, storage };
  const service = createDesktopWrites({
    ...f.deps,
    repo: {
      ...f.repo,
      transition: async (...args: Parameters<typeof f.repo.transition>) =>
        // Reserving is the one transition this move makes from committing to
        // itself; losing it would leave a copy no retry could ever find again.
        args[3] === "committing" && args[4] === "committing" ? false : f.repo.transition(...args),
    },
    publishLock: async (_identityId, run) => run(),
  });
  const item = await service.stat(principal, "/folder");
  const operationId = randomUUID();
  await service.prepare(principal, {
    kind: "move" as const,
    operationId,
    itemId: item.id,
    parentId: "root",
    name: "folder-moved",
    base: item.version,
  });
  await expect(service.commit(principal, operationId)).rejects.toBeTruthy();
  expect(moves).toEqual([]);
  expect((await service.stat(principal, "/folder/child")).id).toBeTruthy();
});

it("finishes a folder move whose item record had not yet followed the copy", async () => {
  const f = await fixture();
  const { storage, raw, moves } = copyingStorage({ "/folder/child": "child" });
  // Stopping between the storage move and the record that follows it leaves the
  // source gone from storage while the item still points at where it used to be.
  let breakRecord = true;
  const principal: Principal = { ...f.principal, storage };
  const service = createDesktopWrites({
    ...f.deps,
    repo: {
      ...f.repo,
      move: async (...args: Parameters<typeof f.repo.move>) => {
        if (breakRecord) {
          breakRecord = false;
          throw Error("record store went away");
        }
        return f.repo.move(...args);
      },
    },
    publishLock: async (_identityId, run) => run(),
  });
  const item = await service.stat(principal, "/folder");
  const operationId = randomUUID();
  await service.prepare(principal, {
    kind: "move" as const,
    operationId,
    itemId: item.id,
    parentId: "root",
    name: "folder-moved",
    base: item.version,
  });
  await expect(service.commit(principal, operationId)).rejects.toBeTruthy();
  await expect(raw.stat("/folder")).rejects.toMatchObject({ kind: "not_found" });
  expect((await service.commit(principal, operationId)).state).toBe("completed");
  // The retry writes the record rather than copying the tree a second time.
  expect(moves).toHaveLength(1);
  expect((await service.stat(principal, "/folder-moved")).id).toBe(item.id);
});
