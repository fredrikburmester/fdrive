import { AdminUser, AdminUsersResponse, ROUTES } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createMemoryStorage } from "@fdrive/testkit";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { COOKIE_NAME, hashSessionId } from "../auth/sessions.js";
import { loadConfig } from "../config.js";
import { seedLocalProvider } from "../providers/test-fixtures/index.ts";
import { registerLocalUserRoutes } from "./routes.js";
import { createLocalUserService } from "./service.js";
import { FAST_PASSWORDS, seedLocalUsers } from "./test-fixtures/index.ts";
import { createLocalUserStore } from "./users.js";

async function harness(options: { isAdmin?: boolean } = {}) {
  const repos = createMemoryRepos();
  const row = await seedLocalProvider(repos);
  await seedLocalUsers(repos, [
    { username: "alice", password: "alice-pass" },
    { username: "bob", password: "bob-pass" },
  ]);
  const account = await repos.accounts.create({ displayName: "alice" });
  await repos.accounts.setAdmin(account.id, true);
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: row.id,
    externalUsername: "alice",
  });
  const store = createLocalUserStore({
    repo: repos.localUsers,
    grants: repos.localGrants,
    passwords: FAST_PASSWORDS,
  });
  const service = createLocalUserService({
    repos,
    store,
    passwords: FAST_PASSWORDS,
    master: Buffer.alloc(32, 51),
    providerId: async () => row.id,
  });
  const principal: Principal = {
    accountId: account.id,
    identityId: identity.id,
    username: "alice",
    isAdmin: options.isAdmin ?? true,
    storage: createMemoryStorage(),
  };
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 52).toString("base64"),
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    version: "test",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerLocalUserRoutes(groups, { service }),
  });
  const call = (
    path: string,
    init: { method?: string; body?: unknown; raw?: string; session?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        "content-type": "application/json",
        ...(init.session === undefined ? {} : { cookie: `${COOKIE_NAME}=${init.session}` }),
      },
      ...(init.raw !== undefined
        ? { body: init.raw }
        : init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
    });
  return { repos, account, identity, store, service, call };
}

const userPath = (username: string) => `${ROUTES.admin.users}/${encodeURIComponent(username)}`;

describe("/admin/users", () => {
  it("lists, adds, changes and removes users", async () => {
    const h = await harness();
    const list = AdminUsersResponse.parse(await (await h.call(ROUTES.admin.users)).json());
    expect(list.available).toBe(true);
    expect(list.users.map((user) => [user.username, user.isYou])).toEqual([
      ["alice", true],
      ["bob", false],
    ]);

    const created = await h.call(ROUTES.admin.users, {
      method: "POST",
      body: { username: "carol", password: "carol-pass", isAdmin: true },
    });
    expect(created.status).toBe(201);
    expect(AdminUser.parse(await created.json())).toMatchObject({
      username: "carol",
      isAdmin: true,
    });

    const disabled = await h.call(userPath("carol"), {
      method: "PATCH",
      body: { disabled: true },
    });
    expect(disabled.status).toBe(200);
    expect(AdminUser.parse(await disabled.json()).disabled).toBe(true);

    // An administrator resetting their own password from the browser stays signed in.
    await h.repos.sessions.create({
      idHash: hashSessionId("admin-session"),
      accountId: h.account.id,
      activeIdentityId: h.identity.id,
      expiresAt: new Date(Date.now() + 3_600_000),
      userAgent: null,
      ip: null,
    });
    const own = await h.call(userPath("alice"), {
      method: "PATCH",
      session: "admin-session",
      body: { password: "alice-new-pass" },
    });
    expect(own.status).toBe(200);
    expect(
      await h.repos.sessions.getByIdHash(hashSessionId("admin-session"), new Date()),
    ).not.toBeNull();

    const removed = await h.call(userPath("carol"), { method: "DELETE" });
    expect(await removed.json()).toEqual({ ok: true });
    expect(await h.repos.localUsers.get("carol")).toBeNull();
  });

  it("is for administrators only", async () => {
    const h = await harness({ isAdmin: false });
    for (const [path, method] of [
      [ROUTES.admin.users, "GET"],
      [ROUTES.admin.users, "POST"],
      [userPath("bob"), "PATCH"],
      [userPath("bob"), "DELETE"],
    ] as const) {
      const response = await h.call(path, {
        method,
        ...(method === "GET" ? {} : { body: { disabled: true } }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect(await h.repos.localUsers.get("bob")).not.toBeNull();
  });

  it("refuses bodies and names the contract does not allow", async () => {
    const h = await harness();
    const refused = [
      await h.call(ROUTES.admin.users, {
        method: "POST",
        body: { username: "../etc", password: "long-enough" },
      }),
      await h.call(ROUTES.admin.users, {
        method: "POST",
        body: { username: "carol", password: "short" },
      }),
      await h.call(ROUTES.admin.users, { method: "POST", raw: "{not json" }),
      await h.call(userPath("bob"), { method: "PATCH", body: { nope: true } }),
      await h.call(userPath("x".repeat(256)), { method: "PATCH", body: { disabled: true } }),
      await h.call(userPath("x".repeat(256)), { method: "DELETE" }),
    ];
    expect(refused.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect((await h.repos.localUsers.list()).map((user) => user.username)).toEqual([
      "alice",
      "bob",
    ]);
  });
});

describe("POST /auth/password", () => {
  it("changes the signed-in user's password from their browser session", async () => {
    const h = await harness({ isAdmin: false });
    await h.repos.sessions.create({
      idHash: hashSessionId("raw-session"),
      accountId: h.account.id,
      activeIdentityId: h.identity.id,
      expiresAt: new Date(Date.now() + 3_600_000),
      userAgent: null,
      ip: null,
    });
    const response = await h.call(ROUTES.auth.password, {
      method: "POST",
      session: "raw-session",
      body: { currentPassword: "alice-pass", newPassword: "alice-new-pass" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await h.store.verify("alice", "alice-new-pass")).toMatchObject({ result: "ok" });
    // The session that changed it stays signed in.
    expect(
      await h.repos.sessions.getByIdHash(hashSessionId("raw-session"), new Date()),
    ).not.toBeNull();
  });

  it("refuses a request made with an API token, and a bad body", async () => {
    const h = await harness();
    const token = await h.call(ROUTES.auth.password, {
      method: "POST",
      body: { currentPassword: "alice-pass", newPassword: "alice-new-pass" },
    });
    expect(token.status).toBe(403);
    const bad = await h.call(ROUTES.auth.password, {
      method: "POST",
      session: "raw-session",
      body: { currentPassword: "alice-pass", newPassword: "short" },
    });
    expect(bad.status).toBe(400);
    expect(await h.store.verify("alice", "alice-pass")).toMatchObject({ result: "ok" });
  });
});
