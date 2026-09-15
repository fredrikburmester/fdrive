import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageProvider } from "@fdrive/core";
import { DesktopPublishBusyError, type DesktopPublishLock } from "@fdrive/db";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { memoryRepo } from "../../test/helpers/desktop-repo.js";
import type { Principal } from "../auth/principal.js";
import { publishesSafely } from "./publish-gate.js";
import { createDesktopWrites, NO_WRITES } from "./writes.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const body = (value: string) => new Response(value).body as ReadableStream<Uint8Array>;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Stock storage: no lease, publication qualified by fdrive-side serialization. */
async function fixture(
  options: {
    lock?: boolean;
    publishLock?: DesktopPublishLock;
    lease?: boolean;
    onAuthority?: () => Promise<void>;
    onCopy?: (to: string) => Promise<void>;
  } = {},
) {
  const stateDir = await mkdtemp(join(tmpdir(), "optimistic-"));
  temporary.push(stateDir);
  const memory = memoryRepo();
  const raw = createMemoryStorage({ "/old.txt": "old" });
  const uploaded: string[] = [];
  const copied: string[] = [];
  const base: StorageProvider = {
    ...raw,
    copy: async (from, to, opts) => {
      const result = await raw.copy(from, to, opts);
      copied.push(to);
      await options.onCopy?.(to);
      return result;
    },
    upload: async (path, body, opts) => {
      uploaded.push(path);
      return raw.upload(path, body, opts);
    },
  };
  const storage: StorageProvider = options.lease
    ? { ...base, withWriteLease: (action) => action(base) }
    : { ...base, optimisticPublish: true };
  const principal: Principal = {
    accountId: randomUUID(),
    identityId: randomUUID(),
    username: "test",
    isAdmin: false,
    storage,
    tokenAccess: { mode: "full", paths: ["/"] },
    verifyAuthority: vi.fn(async () => {
      await options.onAuthority?.();
      return true;
    }),
  };
  const service = createDesktopWrites({
    repo: memory.repo,
    stateDir,
    clock: () => new Date(),
    trashPathForStorage: () => null,
    ...(options.lock === false
      ? {}
      : {
          publishLock:
            options.publishLock ?? (async <T>(_id: string, run: () => Promise<T>) => run()),
        }),
  });
  const stage = async (bytes: string) => {
    const original = await service.stat(principal, "/old.txt");
    const request = {
      kind: "upload" as const,
      operationId: randomUUID(),
      parentId: "root",
      name: "old.txt",
      base: { ...original.version, content: sha("old") },
      itemId: original.id,
      size: Buffer.byteLength(bytes),
      sha256: sha(bytes),
    };
    await service.prepare(principal, request);
    await service.upload(principal, request.operationId, body(bytes), new AbortController().signal);
    return request;
  };
  const read = async (path: string) => new Response((await raw.download(path)).body).text();
  const create = async (name: string, bytes: string) => {
    const request = {
      kind: "upload" as const,
      operationId: randomUUID(),
      parentId: "root",
      name,
      base: null,
      size: Buffer.byteLength(bytes),
      sha256: sha(bytes),
    };
    await service.prepare(principal, request);
    await service.upload(principal, request.operationId, body(bytes), new AbortController().signal);
    return request;
  };
  return { ...memory, raw, principal, service, stage, create, read, uploaded, copied };
}

it("qualifies publication by lease, or by fdrive serialization, and never by neither", () => {
  const plain = createMemoryStorage({}) as StorageProvider;
  const leased: StorageProvider = { ...plain, withWriteLease: async (action) => action(plain) };
  const optimistic: StorageProvider = { ...plain, optimisticPublish: true };
  expect(publishesSafely(leased, false)).toBe(true);
  expect(publishesSafely(optimistic, true)).toBe(true);
  // Optimistic publication without the serialization it depends on stays read-only.
  expect(publishesSafely(optimistic, false)).toBe(false);
  expect(publishesSafely(plain, true)).toBe(false);
});

it("publishes on stock storage once fdrive serializes its own writers", async () => {
  const f = await fixture();
  expect(f.service.capabilities(f.principal)).toMatchObject({ update: true });
  const request = await f.stage("saved");
  const result = await f.service.commit(f.principal, request.operationId);
  expect(result.state).toBe("completed");
  expect(await f.read("/old.txt")).toBe("saved");
});

it("stays read-only when the publish lock is not configured", async () => {
  const f = await fixture({ lock: false });
  expect(f.service.capabilities(f.principal)).toEqual(NO_WRITES);
  await expect(f.stage("saved")).rejects.toThrow(/cannot enforce safe writes/);
});

it("refuses to publish over a destination that changed after verification", async () => {
  // `verifyAuthority` runs between the last observation of the original and the
  // rename, which is exactly the window an unfenced external writer occupies.
  // Commit calls verifyAuthority three times: at entry, inside the publish scope,
  // and immediately before the rename. Only the third lands after the base check
  // and the recovery copy, which is the window `unchanged` exists to catch.
  let authorityCalls = 0;
  let arm = false;
  const f = await fixture({
    onAuthority: async () => {
      if (!arm) return;
      authorityCalls += 1;
      if (authorityCalls !== 3) return;
      await f.raw.upload("/old.txt", body("changed by somebody else"), { overwrite: true });
    },
  });
  const request = await f.stage("saved");
  arm = true;
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toThrow(
    /changed remotely/,
  );
  expect(authorityCalls).toBe(3);
  expect(await f.read("/old.txt")).toBe("changed by somebody else");
  const after = await f.service.status(f.principal, request.operationId);
  expect(after.state).toBe("conflict");
});

it("reports a retryable failure, not a conflict, when another write holds the identity", async () => {
  const f = await fixture({
    publishLock: async (identityId) => {
      throw new DesktopPublishBusyError(identityId);
    },
  });
  const request = await f.stage("saved");
  // A `conflict` here would reach the Mac client as `DriveError.writeConflict`,
  // which forks the pending bytes into a conflict copy. Nothing changed remotely,
  // so the status has to be one the client retries instead.
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "rate_limited",
    details: undefined,
  });
  // The original is untouched and the operation stays retryable.
  expect(await f.read("/old.txt")).toBe("old");
});

it("refuses to publish over a write that landed while the recovery copy was verified", async () => {
  // The recovery copy is a snapshot, so digesting it cannot see a write that lands
  // after it is taken. Only the witness from before the copy covers that stretch.
  let fired = false;
  const f = await fixture({
    onCopy: async (to) => {
      if (fired || !to.endsWith("/previous")) return;
      fired = true;
      await f.raw.upload("/old.txt", body("changed by somebody else"), { overwrite: true });
    },
  });
  const request = await f.stage("saved");
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toThrow(
    /changed remotely/,
  );
  expect(fired).toBe(true);
  expect(await f.read("/old.txt")).toBe("changed by somebody else");
});

it("does not take the publish lock when the storage enforces a lease", async () => {
  // The lease already fences every fdrive writer for the length of the action, so
  // taking the lock as well would only pin a database connection to the transfer.
  let taken = 0;
  const f = await fixture({
    lease: true,
    publishLock: async (_id, run) => {
      taken += 1;
      return run();
    },
  });
  const request = await f.stage("saved");
  await f.service.commit(f.principal, request.operationId);
  expect(taken).toBe(0);
  expect(await f.read("/old.txt")).toBe("saved");
});

it("takes the lock for publication only, not for the staged upload", async () => {
  let uploadsFirst = -1;
  let copiesFirst = -1;
  const f = await fixture({
    publishLock: async (_id, run) => {
      uploadsFirst = f.uploaded.length;
      copiesFirst = f.copied.length;
      return run();
    },
  });
  const request = await f.stage("saved");
  await f.service.commit(f.principal, request.operationId);
  // Both the staged upload and the recovery copy are already done by the time the
  // identity is taken, so the critical section is the rename rather than the write.
  expect(uploadsFirst).toBe(1);
  expect(copiesFirst).toBe(1);
  expect(await f.read("/old.txt")).toBe("saved");
});

it("refuses a name taken between resolution and publication", async () => {
  // Name resolution happens outside the critical section now, so two writers can
  // both find the name free. The loser has to hear `name_collision`, which the Mac
  // client retries under a numbered name, not a bare conflict that forks the file.
  const f = await fixture({
    publishLock: async (_id, run) => {
      await f.raw.upload("/new.txt", body("theirs"), { overwrite: true });
      return run();
    },
  });
  const request = await f.create("new.txt", "mine");
  await expect(f.service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "conflict",
    details: { code: "name_collision" },
  });
  expect(await f.read("/new.txt")).toBe("theirs");
});
