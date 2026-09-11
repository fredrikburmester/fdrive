import type { Scope, StorageProvider } from "@fdrive/core";
import type { Identity, IndexQueries } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { ReadAuthorizeResult, ReadAuthorizer } from "../scoping/read-authorizer.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { buildIdentity } from "../scoping/test-fixtures/index.ts";
import { type FolderSizeRoutesDeps, registerFolderSizeRoutes } from "./folder-size.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  SFTPGO_URL: "http://localhost:8080",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const HOME_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
];

function createTestLogger(): Logger {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return logger as unknown as Logger;
}

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function fakeIndexQueries(
  overrides: Partial<Pick<IndexQueries, "rootIdsByName" | "subtreeSize">> = {},
): Pick<IndexQueries, "rootIdsByName" | "subtreeSize"> {
  return {
    rootIdsByName: overrides.rootIdsByName ?? (async () => fail("rootIdsByName")),
    subtreeSize: overrides.subtreeSize ?? (async () => fail("subtreeSize")),
  };
}

/** Allows every target by default; pass a `ReadAuthorizeResult` to override the outcome. */
function fakeAuthorizer(result: ReadAuthorizeResult = { allowed: true }): ReadAuthorizer {
  return { authorize: async () => result };
}

interface BuildAppOptions extends Partial<Omit<FolderSizeRoutesDeps, "resolver" | "identities">> {
  readonly scopes?: readonly Scope[] | null;
  readonly identity?: Identity | null;
  readonly authorizeResult?: ReadAuthorizeResult;
}

function buildApp(deps: BuildAppOptions = {}, username = "alice") {
  const storage = {} as StorageProvider;
  const identity =
    deps.identity === undefined ? buildIdentity({ externalUsername: username }) : deps.identity;
  const principal: Principal = {
    accountId: "00000000-0000-4000-8000-000000000001",
    identityId: identity?.id ?? "00000000-0000-4000-8000-0000000000a1",
    username,
    storage,
    isAdmin: false,
  };

  const { scopes, authorizeResult, ...overrides } = deps;
  const resolvedScopes = scopes === undefined ? HOME_SCOPES : scopes;

  const resolver: Pick<ScopeResolver, "verifiedIndexScopes"> = {
    verifiedIndexScopes: async () =>
      resolvedScopes === null
        ? { available: false, reason: "no_roots" }
        : { available: true, scopes: resolvedScopes },
  };

  const fullDeps: FolderSizeRoutesDeps = {
    indexQueries: fakeIndexQueries(),
    resolver,
    identities: { get: async () => identity },
    createAuthorizer: () => fakeAuthorizer(authorizeResult),
    ...overrides,
  };

  return createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date("2024-06-01T00:00:00.000Z"),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerFolderSizeRoutes(groups, fullDeps),
  });
}

describe("GET /api/v1/fs/folder-size", () => {
  it("sums the indexed bytes and files under the requested folder", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        subtreeSize: async () => ({ bytes: 4096, files: 3 }),
      }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "/photos",
      bytes: 4096,
      files: 3,
      indexed: true,
    });
  });

  it("passes the caller's own scope prefixes and the resolved root-relative prefix", async () => {
    const subtreeSize = vi.fn(async () => ({ bytes: 10, files: 1 }));
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        subtreeSize,
      }),
    });

    await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(subtreeSize).toHaveBeenCalledWith(
      [{ rootId: 1, fsPrefix: "/alice" }],
      1,
      "alice/photos",
    );
  });

  it("matches the whole root for a scope whose fsPrefix is '/'", async () => {
    const subtreeSize = vi.fn(async () => ({ bytes: 0, files: 0 }));
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        subtreeSize,
      }),
      scopes: [{ rootName: "sftpgo", fsPrefix: "/", virtualPrefix: "/" }],
    });

    await app.request("/api/v1/fs/folder-size?path=/");

    expect(subtreeSize).toHaveBeenCalledWith([{ rootId: 1, fsPrefix: "/" }], 1, "");
  });

  it("excludes configured trash nested below the requested parent", async () => {
    const subtreeSize = vi.fn(async () => ({ bytes: 10, files: 1 }));
    const app = buildApp({
      trashPathForStorage: () => "/photos/.trash",
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        subtreeSize,
      }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/photos", bytes: 10, files: 1, indexed: true });
    expect(subtreeSize).toHaveBeenCalledWith(
      [{ rootId: 1, fsPrefix: "/alice" }],
      1,
      "alice/photos",
      ["alice/photos/.trash"],
    );
  });

  it("adds nested mapped roots while excluding their shadowed parent locations", async () => {
    const subtreeSize = vi.fn(async (_scopes: unknown, rootId: number) =>
      rootId === 1 ? { bytes: 100, files: 2 } : { bytes: 40, files: 3 },
    );
    const app = buildApp({
      scopes: [
        { rootName: "home", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "team", fsPrefix: "/projects/team", virtualPrefix: "/shared" },
      ],
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ home: 1, team: 2 }),
        subtreeSize,
      }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/");

    expect(await res.json()).toEqual({ path: "/", bytes: 140, files: 5, indexed: true });
    expect(subtreeSize).toHaveBeenNthCalledWith(
      1,
      [
        { rootId: 1, fsPrefix: "/alice" },
        { rootId: 2, fsPrefix: "/projects/team" },
      ],
      1,
      "alice",
      ["alice/shared"],
    );
    expect(subtreeSize).toHaveBeenNthCalledWith(
      2,
      [
        { rootId: 1, fsPrefix: "/alice" },
        { rootId: 2, fsPrefix: "/projects/team" },
      ],
      2,
      "projects/team",
    );
  });

  it("maps a submount nested below a requested parent through both physical scopes", async () => {
    const subtreeSize = vi.fn(async () => ({ bytes: 5, files: 1 }));
    const app = buildApp({
      scopes: [
        { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "sftpgo", fsPrefix: "/pool/trips", virtualPrefix: "/photos/trips" },
      ],
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        subtreeSize,
      }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(await res.json()).toEqual({ path: "/photos", bytes: 10, files: 2, indexed: true });
    expect(subtreeSize).toHaveBeenNthCalledWith(
      1,
      [
        { rootId: 1, fsPrefix: "/alice" },
        { rootId: 1, fsPrefix: "/pool/trips" },
      ],
      1,
      "alice/photos",
      ["alice/photos/trips"],
    );
    expect(subtreeSize).toHaveBeenNthCalledWith(
      2,
      [
        { rootId: 1, fsPrefix: "/alice" },
        { rootId: 1, fsPrefix: "/pool/trips" },
      ],
      1,
      "pool/trips",
    );
  });

  it("excludes trash inside a mapped root and avoids overlapping parent exclusions", async () => {
    const subtreeSize = vi.fn(async () => ({ bytes: 5, files: 1 }));
    const app = buildApp({
      scopes: [
        { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "sftpgo", fsPrefix: "/pool/team", virtualPrefix: "/shared" },
      ],
      trashPathForStorage: () => "/shared/.trash",
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        subtreeSize,
      }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/");

    expect(await res.json()).toEqual({ path: "/", bytes: 10, files: 2, indexed: true });
    expect(subtreeSize).toHaveBeenNthCalledWith(
      1,
      [
        { rootId: 1, fsPrefix: "/alice" },
        { rootId: 1, fsPrefix: "/pool/team" },
      ],
      1,
      "alice",
      ["alice/shared"],
    );
    expect(subtreeSize).toHaveBeenNthCalledWith(
      2,
      [
        { rootId: 1, fsPrefix: "/alice" },
        { rootId: 1, fsPrefix: "/pool/team" },
      ],
      1,
      "pool/team",
      ["pool/team/.trash"],
    );
  });

  it("live-authorizes nested mappings and omits a mapping that is no longer readable", async () => {
    const authorize = vi.fn(async ({ path }: { path: string }) =>
      path === "/shared"
        ? ({ allowed: false, reason: "denied" } as const)
        : ({ allowed: true } as const),
    );
    const subtreeSize = vi.fn(async () => ({ bytes: 10, files: 1 }));
    const app = buildApp({
      scopes: [
        { rootName: "home", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "team", fsPrefix: "/projects/team", virtualPrefix: "/shared" },
      ],
      createAuthorizer: () => ({ authorize }),
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ home: 1, team: 2 }),
        subtreeSize,
      }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/");

    expect(await res.json()).toEqual({ path: "/", bytes: 10, files: 1, indexed: true });
    expect(authorize).toHaveBeenCalledWith({ path: "/", kind: "dir" });
    expect(authorize).toHaveBeenCalledWith({ path: "/shared", kind: "dir" });
    expect(subtreeSize).toHaveBeenCalledTimes(1);
  });

  it("returns 502 rather than a partial total when a nested mapping read is unavailable", async () => {
    const authorize = vi.fn(async ({ path }: { path: string }) =>
      path === "/shared"
        ? ({ allowed: false, reason: "unavailable" } as const)
        : ({ allowed: true } as const),
    );
    const rootIdsByName = vi.fn(async () => ({ home: 1, team: 2 }));
    const app = buildApp({
      scopes: [
        { rootName: "home", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "team", fsPrefix: "/projects/team", virtualPrefix: "/shared" },
      ],
      createAuthorizer: () => ({ authorize }),
      indexQueries: fakeIndexQueries({ rootIdsByName }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/");

    expect(res.status).toBe(502);
    expect(rootIdsByName).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing path", async () => {
    const app = buildApp();

    const res = await app.request("/api/v1/fs/folder-size");

    expect(res.status).toBe(400);
  });

  it("returns 400 for a path that fails to normalize", async () => {
    const app = buildApp();

    const res = await app.request(`/api/v1/fs/folder-size?path=${encodeURIComponent("a\0b")}`);

    expect(res.status).toBe(400);
  });

  it("answers indexed: false when the identity no longer exists", async () => {
    const app = buildApp({ identity: null });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/photos", bytes: 0, files: 0, indexed: false });
  });

  it("answers indexed: false when the identity's verified scopes are unavailable", async () => {
    const app = buildApp({ scopes: null });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/photos", bytes: 0, files: 0, indexed: false });
  });

  it("answers indexed: false when no verified scope covers the requested path", async () => {
    const app = buildApp({
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/photos" }],
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/videos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/videos", bytes: 0, files: 0, indexed: false });
  });

  it("answers indexed: false when the resolved root is not configured in the index", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({}) }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/photos", bytes: 0, files: 0, indexed: false });
  });

  it("answers indexed: false for the trash folder itself", async () => {
    const app = buildApp({ trashPathForStorage: () => "/trash" });

    const res = await app.request("/api/v1/fs/folder-size?path=/trash");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/trash", bytes: 0, files: 0, indexed: false });
  });

  it("answers indexed: false for a folder nested under trash", async () => {
    const app = buildApp({ trashPathForStorage: () => "/trash" });

    const res = await app.request("/api/v1/fs/folder-size?path=/trash/old");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/trash/old", bytes: 0, files: 0, indexed: false });
  });

  it("returns 403 when the live read check denies the folder", async () => {
    const app = buildApp({ authorizeResult: { allowed: false, reason: "denied" } });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(403);
  });

  it("returns 404 when the live read check reports the folder missing", async () => {
    const app = buildApp({ authorizeResult: { allowed: false, reason: "missing" } });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(404);
  });

  it("returns 502 when the live read check is unavailable", async () => {
    const app = buildApp({ authorizeResult: { allowed: false, reason: "unavailable" } });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(502);
  });

  it("checks the live read before ever querying the index", async () => {
    const rootIdsByName = vi.fn(async () => ({ sftpgo: 1 }));
    const app = buildApp({
      indexQueries: fakeIndexQueries({ rootIdsByName }),
      authorizeResult: { allowed: false, reason: "denied" },
    });

    await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(rootIdsByName).not.toHaveBeenCalled();
  });

  it("uses the default authorizer built from the caller's own storage when none is injected", async () => {
    const list = vi.fn(async () => []);
    const storage = { list, download: fail } as unknown as StorageProvider;
    const identity = buildIdentity({ externalUsername: "alice" });
    const principal: Principal = {
      accountId: "00000000-0000-4000-8000-000000000001",
      identityId: identity.id,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const deps: FolderSizeRoutesDeps = {
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        subtreeSize: async () => ({ bytes: 0, files: 0 }),
      }),
      resolver: { verifiedIndexScopes: async () => ({ available: true, scopes: HOME_SCOPES }) },
      identities: { get: async () => identity },
    };
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date("2024-06-01T00:00:00.000Z"),
      principalResolver: async () => principal,
      registerRoutes: (groups) => registerFolderSizeRoutes(groups, deps),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith("/photos");
  });
});
