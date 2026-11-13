import { randomUUID } from "node:crypto";
import { GrantPeopleResponse, GrantsResponse, OwnedGrant, ROUTES } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createMemoryStorage } from "@fdrive/testkit";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import { seedLocalProvider } from "../providers/test-fixtures/index.ts";
import { registerGrantRoutes } from "./grant-routes.js";
import { createLocalGrantService } from "./grants.js";
import { seedLocalUsers } from "./test-fixtures/index.ts";

async function harness() {
  const repos = createMemoryRepos();
  const row = await seedLocalProvider(repos);
  await seedLocalUsers(repos, [
    { username: "alice", password: "alice-pass" },
    { username: "bob", password: "bob-pass" },
  ]);
  const account = await repos.accounts.create({ displayName: "alice" });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: row.id,
    externalUsername: "alice",
  });
  // Alice's files: one folder to share.
  const storage = createMemoryStorage({ "/Projects/plan.txt": "plan" });
  const service = createLocalGrantService({
    repos,
    providerId: async () => row.id,
    storageFor: async () => storage,
  });
  const principal: Principal = {
    accountId: account.id,
    identityId: identity.id,
    username: "alice",
    isAdmin: false,
    storage,
  };
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 61).toString("base64"),
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    version: "test",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerGrantRoutes(groups, { service }),
  });
  const call = (path: string, init: { method?: string; body?: unknown; raw?: string } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
      ...(init.raw !== undefined
        ? { body: init.raw }
        : init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
    });
  return { repos, call };
}

const one = (id: string) => `${ROUTES.grants.list}/${id}`;

describe("/grants", () => {
  it("shares a folder, lists it, changes its access and stops sharing it", async () => {
    const h = await harness();
    expect(GrantPeopleResponse.parse(await (await h.call(ROUTES.grants.people)).json())).toEqual({
      usernames: ["bob"],
    });

    const created = await h.call(ROUTES.grants.list, {
      method: "POST",
      body: { path: "/Projects", username: "bob", access: "read" },
    });
    expect(created.status).toBe(201);
    const grant = OwnedGrant.parse(await created.json());
    expect(grant).toMatchObject({ path: "/Projects", username: "bob", access: "read" });

    const listed = GrantsResponse.parse(await (await h.call(ROUTES.grants.list)).json());
    expect(listed).toEqual({ available: true, owned: [grant], received: [] });

    const changed = await h.call(one(grant.id), { method: "PATCH", body: { access: "write" } });
    expect(OwnedGrant.parse(await changed.json()).access).toBe("write");

    const removed = await h.call(one(grant.id), { method: "DELETE" });
    expect(await removed.json()).toEqual({ ok: true });
    expect(await h.repos.localGrants.listOwned("alice")).toEqual([]);
  });

  it("refuses malformed bodies and share ids", async () => {
    const h = await harness();
    const statuses = [
      await h.call(ROUTES.grants.list, {
        method: "POST",
        body: { path: "/Projects", username: "bob", access: "admin" },
      }),
      await h.call(ROUTES.grants.list, { method: "POST", raw: "{not json" }),
      await h.call(one(randomUUID()), { method: "PATCH", body: { access: "owner" } }),
      await h.call(one("not-a-uuid"), { method: "PATCH", body: { access: "read" } }),
      await h.call(one("not-a-uuid"), { method: "DELETE" }),
    ].map((response) => response.status);
    expect(statuses).toEqual([400, 400, 400, 400, 400]);
    expect(await h.repos.localGrants.listOwned("alice")).toEqual([]);
  });

  it("answers not_found for a share that is not yours", async () => {
    const h = await harness();
    expect((await h.call(one(randomUUID()), { method: "DELETE" })).status).toBe(404);
  });
});
