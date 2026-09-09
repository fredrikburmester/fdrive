import type { IndexerDirectoryResponse } from "@fdrive/contracts";
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
import { createInMemoryMountMappingStore } from "./mount-mapping-store.ts";
import { createSettingsScopeOverrideStore } from "./override-store.ts";
import { createScopeResolver, type ScopeResolver } from "./resolver.ts";
import { registerScopeRoutes, type ScopeRoutesDeps } from "./routes.js";
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
    resolverOverrides?: Partial<
      Pick<ScopeResolver, "status" | "setOverrides" | "mountMappings" | "setMountMappings">
    >;
    /** Indexer directory listings by `"<root>:<path>"`; unlisted directories read as unreachable. */
    indexerFixtures?: ReadonlyMap<string, IndexerDirectoryResponse>;
    /** Gives every user the fake "shared" folder mounted at this virtual path. */
    mountSharedAt?: string;
    suggester?: ScopeRoutesDeps["suggester"];
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
      ...(options.mountSharedAt === undefined
        ? {}
        : { virtualFolders: [{ name: "shared", virtualPath: options.mountSharedAt }] }),
    })),
    ...(options.mountSharedAt === undefined ? {} : { folders: [{ name: "shared" }] }),
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
      mountMappings: createInMemoryMountMappingStore(),
      connection: connectionStore,
      indexRoots: INDEX_ROOTS,
      indexer: fakeIndexerDirectory(options.indexerFixtures ?? new Map()),
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
      registerScopeRoutes(groups, {
        resolver,
        identities: repos.identities,
        suggester: options.suggester ?? { suggest: async () => ({ mounts: [] }) },
      });
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
    expect(putBody.overrides).toEqual([
      { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" },
    ]);

    const getRes = await h.call(`/api/v1/account/identities/${id}/scope`, { cookie: alice.cookie });
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.usesOverride).toBe(true);
    expect(getBody.virtualPrefixes).toEqual(["/", "/shared"]);
  });

  it("names an unmapped mount, then verifies through a mapping or an unindexed acknowledgement", async () => {
    const empty: IndexerDirectoryResponse = { items: [], overflow: false };
    const h = harness({
      adminUsernames: ["alice"],
      mountSharedAt: "/shared",
      indexerFixtures: new Map([
        ["sftpgo:/alice", empty],
        ["sftpgo:/_folders/shared", empty],
      ]),
    });
    const alice = await h.login("alice");
    const id = alice.me.activeIdentityId;

    const before = (await (
      await h.call(`/api/v1/account/identities/${id}/scope`, { cookie: alice.cookie })
    ).json()) as Record<string, unknown>;
    expect(before.status).toBe("unavailable");
    expect(before.reason).toBe("unmapped_mount");
    expect(before.unmappedMounts).toEqual([{ virtualPath: "/shared", kind: "dir" }]);

    const acknowledged = await h.call(`/api/v1/account/identities/${id}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: { scopes: [], unindexedPrefixes: ["/shared"] },
    });
    expect(acknowledged.status).toBe(200);
    const acknowledgedBody = (await acknowledged.json()) as Record<string, unknown>;
    expect(acknowledgedBody.status).toBe("available");
    expect(acknowledgedBody.usesOverride).toBe(true);
    expect(acknowledgedBody.unmappedMounts).toEqual([]);
    expect(acknowledgedBody.virtualPrefixes).toEqual(["/"]);
    expect(acknowledgedBody.unindexedPrefixes).toEqual(["/shared"]);

    const mapped = await h.call(`/api/v1/account/identities/${id}/scope`, {
      cookie: alice.cookie,
      method: "PUT",
      body: {
        scopes: [{ rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" }],
      },
    });
    const mappedBody = (await mapped.json()) as Record<string, unknown>;
    expect(mapped.status).toBe(200);
    expect(mappedBody.status).toBe("available");
    expect(mappedBody.virtualPrefixes).toEqual(["/", "/shared"]);
    expect(mappedBody.unverifiedPrefixes).toEqual([]);
  });

  it("reports the validation reason in the 400 details", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");

    const unknownRoot = await h.call(
      `/api/v1/account/identities/${alice.me.activeIdentityId}/scope`,
      {
        cookie: alice.cookie,
        method: "PUT",
        body: { scopes: [{ rootName: "elsewhere", fsPrefix: "/x", virtualPrefix: "/x" }] },
      },
    );
    expect(unknownRoot.status).toBe(400);
    const unknownRootBody = (await unknownRoot.json()) as {
      error: { details?: { reason?: string } };
    };
    expect(unknownRootBody.error.details?.reason).toBe("unknown_root");

    const collision = await h.call(
      `/api/v1/account/identities/${alice.me.activeIdentityId}/scope`,
      {
        cookie: alice.cookie,
        method: "PUT",
        body: {
          scopes: [{ rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" }],
          unindexedPrefixes: ["/shared"],
        },
      },
    );
    expect(collision.status).toBe(400);
    const collisionBody = (await collision.json()) as {
      error: { details?: { issues?: { path: unknown[] }[] } };
    };
    expect(collisionBody.error.details?.issues?.[0]?.path).toEqual(["unindexedPrefixes"]);
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

  it("adopts a folder mapping for every login that mounts the folder, and serves suggestions", async () => {
    const empty: IndexerDirectoryResponse = { items: [], overflow: false };
    const suggest = vi.fn(async () => ({
      mounts: [
        {
          virtualPath: "/shared",
          suggestions: [{ rootName: "sftpgo", fsPrefix: "/_folders/shared" }],
        },
      ],
    }));
    const h = harness({
      adminUsernames: ["alice"],
      mountSharedAt: "/shared",
      indexerFixtures: new Map([
        ["sftpgo:/alice", empty],
        ["sftpgo:/bob", empty],
        ["sftpgo:/_folders/shared", empty],
      ]),
      suggester: { suggest },
    });
    const alice = await h.login("alice");
    const bob = await h.login("bob");
    const aliceId = alice.me.activeIdentityId;

    const suggestions = await h.call(`/api/v1/account/identities/${aliceId}/scope/suggestions`, {
      cookie: alice.cookie,
    });
    expect(suggestions.status).toBe(200);
    expect(((await suggestions.json()) as { mounts: unknown[] }).mounts).toHaveLength(1);
    // Suggestions are administrator-only.
    const denied = await h.call(
      `/api/v1/account/identities/${bob.me.activeIdentityId}/scope/suggestions`,
      { cookie: bob.cookie },
    );
    expect(denied.status).toBe(403);

    const put = await h.call("/api/v1/system/mount-mappings", {
      cookie: alice.cookie,
      method: "PUT",
      body: {
        mappings: [{ virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" }],
      },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      mappings: [{ virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" }],
    });

    const aliceStatus = (await (
      await h.call(`/api/v1/account/identities/${aliceId}/scope`, { cookie: alice.cookie })
    ).json()) as Record<string, unknown>;
    expect(aliceStatus.status).toBe("available");
    expect(aliceStatus.virtualPrefixes).toEqual(["/", "/shared"]);
    expect(aliceStatus.overrides).toEqual([]);
    expect(aliceStatus.adoptedMappings).toEqual([
      { rootName: "sftpgo", fsPrefix: "/_folders/shared", virtualPrefix: "/shared" },
    ]);
    // Bob mounts the same folder and needs nothing stored on his own login.
    const bobStatus = (await (
      await h.call(`/api/v1/account/identities/${bob.me.activeIdentityId}/scope`, {
        cookie: bob.cookie,
      })
    ).json()) as Record<string, unknown>;
    expect(bobStatus.status).toBe("available");
    expect(bobStatus.virtualPrefixes).toEqual(["/", "/shared"]);
    expect(bobStatus.usesOverride).toBe(false);

    const bobDenied = await h.call("/api/v1/system/mount-mappings", {
      cookie: bob.cookie,
      method: "PUT",
      body: { mappings: [] },
    });
    expect(bobDenied.status).toBe(403);

    const invalid = await h.call("/api/v1/system/mount-mappings", {
      cookie: alice.cookie,
      method: "PUT",
      body: { mappings: [{ virtualPath: "/shared", rootName: "nope", fsPrefix: "/x" }] },
    });
    expect(invalid.status).toBe(400);
    expect(
      ((await invalid.json()) as { error: { details?: { reason?: string } } }).error.details
        ?.reason,
    ).toBe("unknown_root");
  });

  it("lists folder mappings, rejects a malformed list, and surfaces unexpected failures", async () => {
    const h = harness({ adminUsernames: ["alice"] });
    const alice = await h.login("alice");

    const list = await h.call("/api/v1/system/mount-mappings", { cookie: alice.cookie });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ mappings: [] });

    const malformed = await h.call("/api/v1/system/mount-mappings", {
      cookie: alice.cookie,
      method: "PUT",
      body: { mappings: [{ virtualPath: "/", rootName: "sftpgo", fsPrefix: "/x" }] },
    });
    expect(malformed.status).toBe(400);

    const broken = harness({
      adminUsernames: ["alice"],
      resolverOverrides: {
        setMountMappings: async () => {
          throw new Error("settings store down");
        },
        setOverrides: async () => {
          throw new Error("settings store down");
        },
      },
    });
    const admin = await broken.login("alice");
    const failedFolder = await broken.call("/api/v1/system/mount-mappings", {
      cookie: admin.cookie,
      method: "PUT",
      body: { mappings: [] },
    });
    expect(failedFolder.status).toBe(500);
    const failedScope = await broken.call(
      `/api/v1/account/identities/${admin.me.activeIdentityId}/scope`,
      { cookie: admin.cookie, method: "PUT", body: { scopes: [] } },
    );
    expect(failedScope.status).toBe(500);
  });
});
