import { randomUUID } from "node:crypto";
import type { ActivityFacts } from "@fdrive/contracts";
import { createMemoryStorage } from "@fdrive/core/testing";
import type { ActivityFinish, ActivityReadsRepo, ActivityRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";
import type { AppVariables } from "../app.js";
import type { Principal, PrincipalVariables } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { registerMetadataRoutes } from "../metadata/routes.js";
import { createMetadataService } from "../metadata/service.js";
import { recordMetadataAction, recordMetadataCommand } from "./metadata.js";
import { createActivityService } from "./service.js";

const hooks = vi.hoisted(() => ({ repos: vi.fn(), capture: vi.fn(), finish: vi.fn() }));
vi.mock("@fdrive/db", async (original) => ({
  ...(await original<typeof import("@fdrive/db")>()),
  createRepos: hooks.repos,
  captureActivityMetadata: hooks.capture,
  createActivityRepo: () => ({ finish: hooks.finish, lockForCommit: async () => {} }),
}));
beforeEach(() => {
  hooks.repos.mockReset();
  hooks.capture.mockReset();
  hooks.finish.mockReset();
});
async function fixture() {
  const memory = createMemoryRepos();
  const account = await memory.accounts.create({ displayName: "Alice" });
  const principal: Principal = {
    accountId: account.id,
    identityId: randomUUID(),
    storage: createMemoryStorage(),
    username: "a",
    isAdmin: false,
  };
  const operation = { id: randomUUID() };
  const outer = {
    begin: vi.fn(async () => operation),
    claim: vi.fn(async () => true),
    finish: vi.fn(async (_owner: string, _id: string, _outcome: ActivityFinish) => ({
      id: randomUUID(),
    })),
    transaction: vi.fn(async (work: (db: never) => Promise<unknown>) => work({} as never)),
  };
  const activity = createActivityService({
    repo: outer as unknown as ActivityRepo,
    clock: () => new Date(),
    pending: vi.fn(),
  });
  const metadata = createMetadataService(memory);
  hooks.repos.mockReturnValue(memory);
  hooks.capture.mockResolvedValue({ before: { favorite: false }, subjects: [], absent: false });
  hooks.finish.mockResolvedValue({ id: randomUUID() });
  return {
    principal,
    outer,
    activity,
    metadata,
    memory,
    input: { action: "file.favorite.set" as const, requested: { path: "/a", favorite: true } },
  };
}
it("commits metadata with its outcome and reports recorded headers only after the transaction", async () => {
  const h = await fixture();
  const app = new Hono<{ Variables: AppVariables & PrincipalVariables }>();
  app.get("/", async (c) => {
    c.set("principal", h.principal);
    await recordMetadataAction(
      h.activity,
      c,
      h.metadata,
      {
        ...h.input,
        before: { favorite: false },
        subjects: [{ identityId: h.principal.identityId, path: "/a" }],
      },
      async (metadata) => {
        expect(hooks.capture).toHaveBeenCalled();
        await metadata.addFavorite(h.principal.identityId, "/a", "file");
        return 1;
      },
      () => ({ path: "/a", favorite: true }),
    );
    return c.json({ ok: true });
  });
  const response = await app.request("/", {
    headers: { "x-fdrive-operation-id": "favorite-1", "x-fdrive-batch-id": randomUUID() },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-activity-status")).toBe("recorded");
  expect(response.headers.get("x-activity-event-id")).toBeTruthy();
  expect(h.outer.transaction).toHaveBeenCalledOnce();
  expect(hooks.finish).toHaveBeenCalledWith(
    h.principal.accountId,
    expect.any(String),
    expect.objectContaining({
      before: { favorite: false },
      after: { path: "/a", favorite: true },
      outcome: "success",
    }),
  );
  hooks.capture.mockResolvedValueOnce({ before: { favorite: true }, subjects: [], absent: false });
  await recordMetadataCommand(h.activity, h.principal, h.metadata, h.input, async () => {});
  expect(hooks.finish).toHaveBeenLastCalledWith(
    h.principal.accountId,
    expect.any(String),
    expect.objectContaining({ outcome: "skipped" }),
  );
});
it("retains failure intents, prevents duplicate writes and respects revoked authority", async () => {
  const h = await fixture();
  const mutate = vi.fn(async () => "done");
  expect(await recordMetadataCommand(undefined, h.principal, h.metadata, h.input, mutate)).toBe(
    "done",
  );
  h.outer.claim.mockResolvedValueOnce(false);
  await expect(
    recordMetadataCommand(h.activity, h.principal, h.metadata, h.input, mutate),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(mutate).toHaveBeenCalledOnce();
  await expect(
    recordMetadataCommand(
      h.activity,
      { ...h.principal, verifyAuthority: async () => false },
      h.metadata,
      h.input,
      mutate,
    ),
  ).rejects.toMatchObject({ kind: "forbidden" });
  expect(h.outer.finish).toHaveBeenLastCalledWith(
    h.principal.accountId,
    expect.any(String),
    expect.objectContaining({ outcome: "denied" }),
  );
  hooks.finish.mockRejectedValueOnce(Error("commit failed"));
  await expect(
    recordMetadataCommand(h.activity, h.principal, h.metadata, h.input, mutate),
  ).rejects.toThrow("commit failed");
  h.outer.finish.mockRejectedValueOnce(Error("database offline"));
  await expect(
    recordMetadataCommand(
      h.activity,
      h.principal,
      h.metadata,
      h.input,
      async () => {
        throw new ApiHttpError("bad_request", "invalid tag");
      },
      () => ({}) as ActivityFacts,
    ),
  ).rejects.toThrow("invalid tag");
});

it("records tag route results using committed names and an empty after-state on deletion", async () => {
  const h = await fixture();
  const app = new Hono<{ Variables: AppVariables & PrincipalVariables }>();
  app.use("*", async (c, next) => {
    c.set("principal", h.principal);
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof ApiHttpError && error.kind === "not_found" ? 404 : 400,
    ),
  );
  registerMetadataRoutes(
    { public: new Hono<{ Variables: AppVariables }>(), authed: app },
    { activity: h.activity, metadata: h.metadata },
  );
  const tag = await h.metadata.createTag(h.principal.accountId, { name: "Before", color: null });
  const update = await app.request(`/tags/${tag.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "After" }),
  });
  expect(update.status).toBe(200);
  expect(hooks.finish).toHaveBeenLastCalledWith(
    h.principal.accountId,
    expect.any(String),
    expect.objectContaining({ after: { tags: [{ id: tag.id, name: "After", color: null }] } }),
  );
  expect((await app.request(`/tags/${tag.id}`, { method: "DELETE" })).status).toBe(200);
  expect(hooks.finish).toHaveBeenLastCalledWith(
    h.principal.accountId,
    expect.any(String),
    expect.objectContaining({ after: { tags: [] } }),
  );
  expect(
    (
      await app.request(`/tags/${randomUUID()}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Missing" }),
      })
    ).status,
  ).toBe(404);
  await h.principal.storage.upload("/a", new Uint8Array([1]));
  expect(
    (
      await app.request("/fs/tags", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/a", tagIds: [randomUUID()] }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request("/favorites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/a" }),
      })
    ).status,
  ).toBe(200);
  expect(hooks.finish).toHaveBeenLastCalledWith(
    h.principal.accountId,
    expect.any(String),
    expect.objectContaining({ after: { path: "/a", kind: "file", favorite: true } }),
  );
});

it("serves actor-owned Recents from the read journal and admits explicit opens", async () => {
  const h = await fixture();
  const app = new Hono<{ Variables: AppVariables & PrincipalVariables }>();
  app.use("*", async (c, next) => {
    c.set("principal", h.principal);
    await next();
  });
  const openedAt = new Date();
  const recents = vi.fn(async () => [{ path: "/current-name", openedAt }]);
  const admitActivity = vi.fn(async () => randomUUID());
  registerMetadataRoutes(
    { public: new Hono<{ Variables: AppVariables }>(), authed: app },
    {
      metadata: h.metadata,
      reads: { recents } as unknown as ActivityReadsRepo,
      admitActivity,
    },
  );
  expect(await (await app.request("/recents")).json()).toEqual({
    items: [{ path: "/current-name", openedAt: openedAt.toISOString() }],
  });
  expect(recents).toHaveBeenCalledExactlyOnceWith(h.principal.accountId, h.principal.identityId);
  const requestId = randomUUID();
  const response = await app.request("/recents/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/current-name", requestId, at: openedAt.toISOString() }),
  });
  expect(response.status).toBe(200);
  expect(admitActivity).toHaveBeenCalledWith(expect.anything(), {
    identityId: h.principal.identityId,
    path: "/current-name",
    action: "file.open",
    requestId,
    at: openedAt.toISOString(),
  });
});
