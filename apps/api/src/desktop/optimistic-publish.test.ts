import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageProvider } from "@fdrive/core";
import { DesktopPublishBusyError } from "@fdrive/db";
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
async function fixture(options: { lock?: boolean; onAuthority?: () => Promise<void> } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "optimistic-"));
  temporary.push(stateDir);
  const memory = memoryRepo();
  const raw = createMemoryStorage({ "/old.txt": "old" });
  const storage: StorageProvider = { ...raw, optimisticPublish: true };
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
      : { publishLock: async <T>(_id: string, run: () => Promise<T>) => run() }),
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
  return { ...memory, raw, principal, service, stage, read };
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

it("reports a retryable conflict when another write holds the identity", async () => {
  const f = await fixture();
  const service = createDesktopWrites({
    repo: f.repo,
    stateDir: await mkdtemp(join(tmpdir(), "optimistic-busy-")),
    clock: () => new Date(),
    trashPathForStorage: () => null,
    publishLock: async () => {
      throw new DesktopPublishBusyError(f.principal.identityId);
    },
  });
  const request = await f.stage("saved");
  await expect(service.commit(f.principal, request.operationId)).rejects.toMatchObject({
    kind: "conflict",
  });
  // The original is untouched and the operation stays retryable.
  expect(await f.read("/old.txt")).toBe("old");
});
