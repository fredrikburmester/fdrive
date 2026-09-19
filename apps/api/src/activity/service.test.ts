import { randomUUID } from "node:crypto";
import { StorageError } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { ActivityConflict, type ActivityRepo } from "@fdrive/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { createActivityMaintenance } from "./maintenance.js";
import { activityFailure, activityStat, createActivityService } from "./service.js";

const now = new Date("2026-09-14T00:00:00Z");
function setup() {
  const repo = {
    begin: vi.fn(async (_input: unknown) => ({ id: randomUUID() })),
    claim: vi.fn(async () => true),
    heartbeat: vi.fn(async () => {}),
    finish: vi.fn(async () => ({ id: randomUUID() })),
    pending: vi.fn(async () => []),
    recoverAbandoned: vi.fn(async () => null),
  };
  const pending = vi.fn();
  const service = createActivityService({
    repo: repo as unknown as ActivityRepo,
    clock: () => now,
    pending,
  });
  const principal: Principal = {
    accountId: randomUUID(),
    identityId: randomUUID(),
    storage: createMemoryStorage(),
    username: "alice",
    isAdmin: true,
  };
  return { repo, service, principal, pending };
}
afterEach(() => vi.useRealTimers());
describe("personal activity recording boundaries", () => {
  it("persists intent before I/O, captures owner and storage, then confirms one outcome", async () => {
    const { repo, service, principal } = setup();
    const mutate = vi.fn(async () => {
      expect(repo.begin).toHaveBeenCalledOnce();
      expect(repo.claim).toHaveBeenCalledOnce();
      expect(repo.finish).not.toHaveBeenCalled();
      return 7;
    });
    const response = await service.run(
      principal,
      {
        action: "file.upload",
        source: "api",
        batchId: randomUUID(),
        requested: { path: "/a" },
        before: { path: "/a", size: 1 },
        bridge: { namespace: "office", externalId: "file-key" },
        producerOperationId: "original",
        subjects: [{ path: "/a", identityId: principal.identityId, kind: "file" }],
      },
      mutate,
      () => ({ path: "/a", size: 7 }),
    );
    expect(response.value).toBe(7);
    expect(response.historyPending).toBe(false);
    expect(repo.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: principal.accountId,
        identityId: principal.identityId,
        source: "api",
        producerOperationId: "original",
      }),
    );
    expect(repo.finish).toHaveBeenCalledWith(principal.accountId, expect.any(String), {
      outcome: "success",
      after: { path: "/a", size: 7 },
      at: now,
      bridge: { namespace: "office", externalId: "file-key" },
    });
  });
  it("never repeats storage to repair failed history or an already claimed operation", async () => {
    const { repo, service, principal, pending } = setup();
    repo.finish.mockRejectedValueOnce(Error("database unavailable"));
    const mutate = vi.fn(async () => "bytes committed");
    expect(
      await service.run(principal, { action: "file.save", requested: { path: "/a" } }, mutate),
    ).toMatchObject({ value: "bytes committed", eventId: null, historyPending: true });
    expect(pending).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledOnce();
    repo.claim.mockResolvedValue(false);
    await expect(
      service.run(principal, { action: "file.save", requested: { path: "/a" } }, mutate),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(mutate).toHaveBeenCalledOnce();
  });
  it("rejects changed operation input and intent failures before touching storage", async () => {
    const { repo, service, principal } = setup();
    const mutate = vi.fn();
    repo.begin.mockRejectedValueOnce(new ActivityConflict("different input"));
    await expect(
      service.run(principal, { action: "file.save", requested: {} }, mutate),
    ).rejects.toMatchObject({ kind: "conflict" });
    repo.begin.mockRejectedValueOnce(Error("offline"));
    await expect(
      service.run(principal, { action: "file.save", requested: {} }, mutate),
    ).rejects.toThrow("offline");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("records revoked authority, storage denial and caller-specific partial failure", async () => {
    const { repo, service, principal, pending } = setup();
    const mutate = vi.fn();
    await expect(
      service.run(
        { ...principal, verifyAuthority: async () => false },
        { action: "file.delete", requested: {} },
        mutate,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(mutate).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenLastCalledWith(principal.accountId, expect.any(String), {
      outcome: "denied",
      errorCode: "permission_denied",
    });
    repo.finish.mockRejectedValueOnce(Error("offline"));
    await expect(
      service.run(
        principal,
        { action: "file.delete", requested: {}, failure: () => ({ outcome: "partial" }) },
        async () => {
          throw Error("partial delete");
        },
      ),
    ).rejects.toThrow("partial delete");
    expect(pending).toHaveBeenCalledOnce();
    await expect(
      service.run(principal, { action: "file.delete", requested: {} }, async () => {
        throw new ApiHttpError("conflict", "occupied");
      }),
    ).rejects.toThrow("occupied");
  });
  it("links child operations only within the same owner and storage", async () => {
    const { repo, service, principal } = setup();
    const parentId = randomUUID();
    await service.withParent(principal, parentId, () =>
      service.run(principal, { action: "file.create", requested: {} }, async () => "done"),
    );
    expect(repo.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ parentOperationId: parentId }),
    );
    await service.withParent(principal, parentId, () =>
      service.run(
        { ...principal, identityId: randomUUID() },
        { action: "file.create", requested: {} },
        async () => "done",
      ),
    );
    expect(repo.begin.mock.calls.at(-1)?.[0]).not.toHaveProperty("parentOperationId");
  });
  it("heartbeats slow I/O and clears the timer after completion", async () => {
    vi.useFakeTimers();
    const { repo, service, principal, pending } = setup();
    let finish: (() => void) | undefined;
    const work = service.run(
      principal,
      { action: "file.save", requested: {} },
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    repo.heartbeat.mockRejectedValueOnce(Error("offline"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pending).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(repo.heartbeat).toHaveBeenCalledTimes(2);
    finish?.();
    await work;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repo.heartbeat).toHaveBeenCalledTimes(2);
  });
  it.each([
    "unauthorized",
    "reauth_required",
    "forbidden",
    "conflict",
    "not_found",
    "bad_request",
    "unsupported",
  ] as const)("classifies %s without copying exception text into history", (kind) => {
    const result = activityFailure(new ApiHttpError(kind, "SECRET"));
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result.outcome).not.toBe("success");
  });
  it("treats unconfirmed network failures as unknown and permits stat-less snapshots", async () => {
    const { principal } = setup();
    expect(activityFailure(Error("secret"))).toMatchObject({ outcome: "unknown" });
    expect(activityFailure(new StorageError("not_found", "missing"))).toMatchObject({
      outcome: "failed",
    });
    expect(await activityStat(principal.storage, "/missing")).toBeUndefined();
    await principal.storage.mkdir("/d");
    expect(await activityStat(principal.storage, "/d")).toMatchObject({ path: "/d", kind: "dir" });
    await principal.storage.upload("/f", new Uint8Array([1]));
    expect(await activityStat(principal.storage, "/f")).toMatchObject({ kind: "file", size: 1 });
  });
  it("recovers abandoned intents atomically without replaying provider I/O", async () => {
    vi.useFakeTimers();
    const { repo } = setup();
    repo.pending.mockResolvedValue([
      { ownerAccountId: "owner", id: "first", state: "prepared" },
      { ownerAccountId: "owner", id: "second", state: "running" },
    ] as never);
    const reads = { seal: vi.fn(async () => 0) };
    const onError = vi.fn();
    const maintenance = createActivityMaintenance({
      repo: repo as unknown as ActivityRepo,
      reads: reads as never,
      clock: () => now,
      onError,
    });
    await maintenance.run();
    expect(repo.recoverAbandoned).toHaveBeenCalledWith(
      "owner",
      "first",
      expect.objectContaining({ outcome: "cancelled" }),
      new Date(now.getTime() - 600_000),
    );
    expect(repo.recoverAbandoned).toHaveBeenCalledWith(
      "owner",
      "second",
      expect.objectContaining({ outcome: "unknown" }),
      expect.any(Date),
    );
    reads.seal.mockRejectedValueOnce(Error("offline"));
    maintenance.start();
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await maintenance.stop();
  });
});
