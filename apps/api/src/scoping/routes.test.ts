import { MeResponse } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createFakeSftpgoServer, createSftpgoClient } from "@fdrive/sftpgo";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createAuthModule, createLoginLimiter, createTokenSource } from "../auth/index.js";
import { createIdentityClientResolver } from "../auth/provider-client.ts";
import { createIdentityStorageFactory } from "../auth/storage-factory.ts";
import { memoryIdentityOperations } from "../auth/test-fixtures/index.ts";
import type { IndexRootConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { createConnectionStore } from "../connection/store.js";
import { createSettingsScopeOverrideStore } from "./override-store.ts";
import { createScopeResolver, type ScopeResolver } from "./resolver.ts";
import { registerScopeRoutes } from "./routes.js";
import { fakeIndexerDirectory } from "./test-fixtures/index.ts";
import { ScopeOverrideValidationError } from "./validate-overrides.ts";

const USERS = ["alice", "bob"];
const INDEX_ROOTS: IndexRootConfig[] = [
  { name: "sftpgo", sftpgoPath: "/data", indexerPath: "/index-data" },
];

function createTestLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/**
 * A harness with a real cookie-session auth module (login, sessions,
 * identities all backed by in-memory repos and a fake SFTPGo server) and
 * `registerScopeRoutes` wired against a real `ScopeResolver`, so requests
 * exercise the exact cookie/CSRF/admin/ownership checks production uses.
 */
function harness(
  options: {
    adminUsernames?: readonly string[];
    resolverOverrides?: Partial<Pick<ScopeResolver, "status" | "setOverrides">>;
  } = {},
) {
  const now = { value: new Date("2026-09-07T00:00:00Z") };
  const clock = () => now.value;
  const repos = createMemoryRepos();
  const links = memoryIdentityOperations(repos);
  const master = Buffer.alloc(32, 9);
  const config = loadConfig({
    DATABASE_URL: "postgres://test/fdrive",
    SFTPGO_URL: "http://storage.test",
    FDRIVE_MASTER_KEY: master.toString("base64"),
    FDRIVE_COOKIE_SECURE: "auto",
  });
  const server = createFakeSftpgoServer({
    users: USERS.map((username) => ({
      username,
      password: `${username}-pass`,
      permissions: { "/": ["*"] },
    })),
    files: {},
    now: clock,
  });
  const client = createSftpgoClient({ baseUrl: "http://storage.test", fetch: server.fetch });
  const connectionStore = createConnectionStore({
    settings: repos.settings,
    envUrl: config.sftpgoUrl,
    defaultHomeTemplate: config.fdriveHomeTemplate,
    clock,
  });
  const clientForBaseUrl = () => client;
  const clientForIdentity = createIdentityClientResolver({
    identities: repos.identities,
    providers: repos.providers,
    connections: connectionStore,
    clientForBaseUrl,
  });
  const tokenSource = createTokenSource({ repos, master, clock, clientForIdentity });
  const limiter = createLoginLimiter({ clock });
  const storageFactory = createIdentityStorageFactory({ clientForIdentity, tokenSource });
  const auth = createAuthModule({
    repos,
    identityLinks: links,
    clientForBaseUrl,
    clientForIdentity,
    master,
    clock,
    config,
    limiter,
    tokenSource,
    connectionStore,
    storageFactory,
    ...(options.adminUsernames === undefined ? {} : { adminUsernames: options.adminUsernames }),
  });

  const resolver: ScopeResolver = {
    ...createScopeResolver({
      providers: repos.providers,
      overrides: createSettingsScopeOverrideStore(repos.settings),
      connection: connectionStore,
      indexRoots: INDEX_ROOTS,
      indexer: fakeIndexerDirectory(new Map()),
      storageForIdentity: (identity) => storageFactory(identity.id),
      clock,
    }),
    ...options.resolverOverrides,
  };

  const app = createApp({
    config,
    clock,
    logger: createTestLogger(),
    version: "test",
    startedAt: clock(),
    principalResolver: auth.principalResolver,
    registerRoutes: (groups) => {
      auth.registerRoutes(groups);
      registerScopeRoutes(groups, { resolver, identities: repos.identities });
    },
  });

  async function call(
    path: string,
    callOptions: {
      cookie?: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return app.request(path, {
      method: callOptions.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(callOptions.cookie === undefined ? {} : { cookie: callOptions.cookie }),
        ...(callOptions.body === undefined ? {} : { "content-type": "application/json" }),
        ...callOptions.headers,
      },
      ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
    });
  }

  async function login(username = "alice") {
    const response = await call("/api/v1/auth/login", {
      method: "POST",
      body: { username, password: `${username}-pass` },
    });
    const me = MeResponse.parse(await response.json());
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("missing cookie");
    return { cookie, me };
  }

  return { now, clock, repos, resolver, app, call, login };
}

describe("GET /api/v1/account/identities/:id/scope", () => {
  it("returns the caller's own status, redacted for a non-administrator", async () => {
    const h = harness();
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.isAdmin).toBe(false);
    expect(body).not.toHaveProperty("configuredRoots");
    expect(body).not.toHaveProperty("mappings");
    expect(body.virtualPrefixes).toEqual(["/"]);
  });

  it("returns the full mapping for an administrator", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.isAdmin).toBe(true);
    expect(body.configuredRoots).toEqual(["sftpgo"]);
    expect(body.mappings).toEqual([{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }]);
  });

  it("404s for an identity owned by another account", async () => {
    const h = harness();
    const alice = await h.login("alice");
    const bob = await h.login("bob");

    const res = await h.call(`/api/v1/account/identities/${bob.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
    });

    expect(res.status).toBe(404);
  });

  it("404s for an id that does not exist, the same as one owned by another account", async () => {
    const h = harness();
    const alice = await h.login("alice");

    const res = await h.call(
      "/api/v1/account/identities/00000000-0000-4000-8000-000000000999/scope",
      { cookie: alice.cookie },
    );

    expect(res.status).toBe(404);
  });

  it("rejects a request carrying an Authorization header, even with a valid cookie", async () => {
    const h = harness();
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
      headers: { authorization: "Bearer sometoken" },
    });

    expect(res.status).toBe(403);
  });

  it("400s for an id that is not a well-formed identity id, never reaching the database", async () => {
    const h = harness();
    const alice = await h.login("alice");

    const res = await h.call("/api/v1/account/identities/not-a-uuid/scope", {
      cookie: alice.cookie,
    });

    expect(res.status).toBe(400);
  });

  it("401s with no session at all", async () => {
    const h = harness();
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`);

    expect(res.status).toBe(401);
  });
});

describe("PUT /api/v1/account/identities/:id/scope", () => {
  it("rejects a non-administrator", async () => {
    const h = harness();
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: [] },
    });

    expect(res.status).toBe(403);
  });

  it("rejects an invalid body with 400", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: "not-an-array" },
    });

    expect(res.status).toBe(400);
  });

  it("rejects a duplicate virtualPrefix at the contract level before the resolver ever sees it", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: {
        scopes: [
          { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" },
          { rootName: "sftpgo", fsPrefix: "/other", virtualPrefix: "/shared" },
        ],
      },
    });

    expect(res.status).toBe(400);
  });

  it("maps a ScopeOverrideValidationError the resolver itself raises to 400", async () => {
    const h = harness({
      adminUsernames: ["alice"],
      resolverOverrides: {
        setOverrides: async () => {
          throw new ScopeOverrideValidationError("too_many", "at most 32 scope mappings allowed");
        },
      },
    });
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }] },
    });

    expect(res.status).toBe(400);
  });

  it("404s for an identity owned by another account, never distinguishing it from an unknown id", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");
    const bob = await h.login("bob");

    const res = await h.call(`/api/v1/account/identities/${bob.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: [] },
    });

    expect(res.status).toBe(404);
  });

  it("rejects a request carrying an Authorization header, even with a valid cookie", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");

    const res = await h.call(`/api/v1/account/identities/${alice.me.activeIdentityId}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: [] },
      headers: { authorization: "Bearer sometoken" },
    });

    expect(res.status).toBe(403);
  });

  it("persists an override, visible on the very next GET, with the resolver cache invalidated", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");
    const id = alice.me.activeIdentityId;

    // Prime the resolver's verification cache under the plain template first.
    const beforeRes = await h.call(`/api/v1/account/identities/${id}/scope`, {
      cookie: alice.cookie,
    });
    const before = (await beforeRes.json()) as Record<string, unknown>;
    expect(before.usesOverride).toBe(false);
    expect(before.virtualPrefixes).toEqual(["/"]);

    const putRes = await h.call(`/api/v1/account/identities/${id}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }] },
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as Record<string, unknown>;
    expect(putBody.usesOverride).toBe(true);
    expect(putBody.mappings).toEqual([
      { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
      { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" },
    ]);

    const getRes = await h.call(`/api/v1/account/identities/${id}/scope`, { cookie: alice.cookie });
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.usesOverride).toBe(true);
    expect(getBody.virtualPrefixes).toEqual(["/", "/shared"]);
  });

  it("resets to the plain template when scopes is an empty array", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");
    const id = alice.me.activeIdentityId;

    await h.call(`/api/v1/account/identities/${id}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }] },
    });

    const resetRes = await h.call(`/api/v1/account/identities/${id}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: [] },
    });
    const resetBody = (await resetRes.json()) as Record<string, unknown>;

    expect(resetRes.status).toBe(200);
    expect(resetBody.usesOverride).toBe(false);
    expect(resetBody.virtualPrefixes).toEqual(["/"]);
  });
});
