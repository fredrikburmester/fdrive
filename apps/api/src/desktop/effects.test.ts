import { randomUUID } from "node:crypto";
import type { DesktopEffectsRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createMemoryStorage } from "@fdrive/testkit";
import { afterEach, expect, it, vi } from "vitest";
import type { Principal } from "../auth/principal.js";
import type { ConfiguredMappingsResult } from "../scoping/types.js";
import { createDesktopEffectContext, createDesktopEffectsWorker } from "./effects.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const repo = {
    processNext: vi.fn<DesktopEffectsRepo["processNext"]>().mockResolvedValue({ state: "idle" }),
    pending: vi.fn<DesktopEffectsRepo["pending"]>().mockResolvedValue(false),
    status: vi.fn<DesktopEffectsRepo["status"]>().mockResolvedValue([]),
  };
  const bus = { publish: vi.fn() };
  const eventLog = { record: vi.fn() };
  return { repo, bus, eventLog, worker: createDesktopEffectsWorker({ repo, bus, eventLog }) };
}
it("starts recovery without a Mac, retries later, bounds each batch and awaits shutdown", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const event = {
    type: "fs" as const,
    identityId: "identity",
    op: "mkdir" as const,
    paths: ["/new"],
    at: new Date().toISOString(),
  };
  f.repo.processNext
    .mockImplementationOnce(async (publish) => {
      publish(event);
      return { state: "completed", identityId: "identity", operationId: "op" };
    })
    .mockResolvedValueOnce({
      state: "failed",
      identityId: "identity",
      operationId: "second",
      retryAt: new Date(),
    });
  f.worker.start();
  f.worker.start();
  f.worker.kick();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.repo.processNext).toHaveBeenCalledTimes(3);
  expect(f.bus.publish).toHaveBeenCalledWith(event);
  expect(f.eventLog.record).toHaveBeenCalledWith(
    "general",
    "warn",
    expect.any(String),
    expect.objectContaining({ operationId: "second" }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.repo.processNext).toHaveBeenCalledTimes(4);
  f.repo.processNext.mockResolvedValue({ state: "retired", identityId: "i", operationId: "o" });
  f.worker.kick();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.repo.processNext).toHaveBeenCalledTimes(36);
  let release!: (result: { state: "idle" }) => void;
  f.repo.processNext.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.worker.kick();
  let stopped = false;
  const stopping = f.worker.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);
  release({ state: "idle" });
  await stopping;
  const count = f.repo.processNext.mock.calls.length;
  f.worker.start();
  f.worker.kick();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.repo.processNext).toHaveBeenCalledTimes(count);
  await expect(f.worker.beforeWrite("i")).rejects.toMatchObject({ kind: "upstream_unavailable" });
});
it("drains older saves before a new publication and blocks while recovery is pending", async () => {
  const f = fixture();
  f.worker.kick();
  await f.worker.beforeWrite("identity");
  expect(f.repo.processNext).toHaveBeenLastCalledWith(expect.any(Function), "identity");
  f.repo.pending.mockResolvedValue(true);
  await expect(f.worker.beforeWrite("identity")).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  f.repo.processNext.mockRejectedValue(Error("database offline"));
  f.worker.kick();
  await f.worker.stop();
  expect(f.eventLog.record).toHaveBeenCalledWith("general", "error", expect.any(String));
});
it("captures trusted Office locations once, handling unmapped paths and ownership safely", async () => {
  const repos = createMemoryRepos();
  const account = await repos.accounts.create({ displayName: "A" });
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://test" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const principal: Principal = {
    accountId: account.id,
    identityId: identity.id,
    username: "alice",
    isAdmin: false,
    storage: createMemoryStorage(),
  };
  const mapping = vi
    .fn<(_identity: typeof identity) => Promise<ConfiguredMappingsResult>>()
    .mockResolvedValue({
      available: true,
      providerId: provider.id,
      homeTemplateRaw: "root:/alice",
      scopes: [
        { rootName: "root", virtualPrefix: "/", fsPrefix: "/alice" },
        { rootName: "other", virtualPrefix: "/mount", fsPrefix: "/" },
      ],
    });
  const resolve = createDesktopEffectContext(repos.identities, mapping);
  const move = { from: "/a", to: "/b", directory: false, trash: false };
  expect(await resolve(principal, move)).toMatchObject({
    office: { providerId: provider.id, rootName: "root", from: "alice/a", to: "alice/b" },
  });
  expect(mapping).toHaveBeenCalledTimes(1);
  expect(await resolve(principal, { ...move, to: "/mount/b" })).toMatchObject({
    office: { to: null },
  });
  for (const context of [
    { ...move, from: null },
    { ...move, to: "/a" },
    { ...move, trash: true },
  ])
    expect(await resolve(principal, context)).toMatchObject({ office: null });
  mapping.mockResolvedValue({ available: false, reason: "no_connection" });
  expect(await resolve(principal, move)).toMatchObject({ office: null });
  mapping.mockResolvedValue({
    available: true,
    providerId: provider.id,
    homeTemplateRaw: "root:/alice",
    scopes: [],
  });
  expect(await resolve(principal, move)).toMatchObject({ office: null });
  await expect(resolve({ ...principal, accountId: randomUUID() }, move)).rejects.toMatchObject({
    kind: "unauthorized",
  });
  await expect(resolve({ ...principal, identityId: randomUUID() }, move)).rejects.toMatchObject({
    kind: "unauthorized",
  });
});

it("does not wait for another identity's background recovery before admitting a save", async () => {
  const f = fixture();
  let release!: (result: { state: "idle" }) => void;
  f.repo.processNext.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.worker.kick();
  try {
    await f.worker.beforeWrite("other-identity");
    expect(f.repo.processNext).toHaveBeenLastCalledWith(expect.any(Function), "other-identity");
    f.repo.processNext.mockRejectedValueOnce(Error("database lock timeout"));
    await expect(f.worker.beforeWrite("other-identity")).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
  } finally {
    release({ state: "idle" });
    await f.worker.stop();
  }
});
