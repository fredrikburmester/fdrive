import type { Scope, StorageProvider } from "@fdrive/core";
import type { IndexQueries } from "@fdrive/db";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { type FolderSizeRoutesDeps, registerFolderSizeRoutes } from "./folder-size.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const HOME_SCOPES: readonly Scope[] = [
  { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" },
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

interface BuildAppOptions extends Partial<Omit<FolderSizeRoutesDeps, "resolver">> {
  readonly scopes?: readonly Scope[] | null;
}

function buildApp(deps: BuildAppOptions = {}, username = "alice") {
  // The scope is the permission: sizing a folder reads nothing from storage.
  const storage = {} as StorageProvider;
  const principal: Principal = {
    accountId: "00000000-0000-4000-8000-000000000001",
    identityId: "00000000-0000-4000-8000-0000000000a1",
    username,
    storage,
    isAdmin: false,
  };

  const { scopes, ...overrides } = deps;
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
        rootIdsByName: async () => ({ files: 1 }),
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
        rootIdsByName: async () => ({ files: 1 }),
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
        rootIdsByName: async () => ({ files: 1 }),
        subtreeSize,
      }),
      scopes: [{ rootName: "files", fsPrefix: "/", virtualPrefix: "/" }],
    });

    await app.request("/api/v1/fs/folder-size?path=/");

    expect(subtreeSize).toHaveBeenCalledWith([{ rootId: 1, fsPrefix: "/" }], 1, "", [".trash"]);
  });

  it("leaves the Trash out of the size of the files that hold it", async () => {
    const subtreeSize = vi.fn(async () => ({ bytes: 10, files: 1 }));
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ files: 1 }),
        subtreeSize,
      }),
    });

    const res = await app.request("/api/v1/fs/folder-size?path=/");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/", bytes: 10, files: 1, indexed: true });
    expect(subtreeSize).toHaveBeenCalledWith([{ rootId: 1, fsPrefix: "/alice" }], 1, "alice", [
      "alice/.trash",
    ]);
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
      ["alice/shared", "alice/.trash"],
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
        { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" },
        { rootName: "files", fsPrefix: "/pool/trips", virtualPrefix: "/photos/trips" },
      ],
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ files: 1 }),
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

  it("counts only the mappings the login has now: a revoked share drops out at once", async () => {
    const subtreeSize = vi.fn(async () => ({ bytes: 10, files: 1 }));
    const home = { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" };
    const shared = { rootName: "files", fsPrefix: "/bob/team", virtualPrefix: "/shared" };
    let scopes: Scope[] = [home, shared];
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date("2024-06-01T00:00:00.000Z"),
      principalResolver: async () => ({
        accountId: "00000000-0000-4000-8000-000000000001",
        identityId: "00000000-0000-4000-8000-0000000000a1",
        username: "alice",
        storage: {} as StorageProvider,
        isAdmin: false,
      }),
      registerRoutes: (groups) =>
        registerFolderSizeRoutes(groups, {
          indexQueries: fakeIndexQueries({
            rootIdsByName: async () => ({ files: 1 }),
            subtreeSize,
          }),
          resolver: { verifiedIndexScopes: async () => ({ available: true, scopes }) },
        }),
    });

    expect(await (await app.request("/api/v1/fs/folder-size?path=/")).json()).toEqual({
      path: "/",
      bytes: 20,
      files: 2,
      indexed: true,
    });
    scopes = [home];
    expect(await (await app.request("/api/v1/fs/folder-size?path=/")).json()).toEqual({
      path: "/",
      bytes: 10,
      files: 1,
      indexed: true,
    });
    expect(subtreeSize).toHaveBeenCalledTimes(3);
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

  it("answers indexed: false when the identity's verified scopes are unavailable", async () => {
    const app = buildApp({ scopes: null });

    const res = await app.request("/api/v1/fs/folder-size?path=/photos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/photos", bytes: 0, files: 0, indexed: false });
  });

  it("answers indexed: false when no verified scope covers the requested path", async () => {
    const app = buildApp({
      scopes: [{ rootName: "files", fsPrefix: "/alice", virtualPrefix: "/photos" }],
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
    const app = buildApp();

    const res = await app.request("/api/v1/fs/folder-size?path=/.trash");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/.trash", bytes: 0, files: 0, indexed: false });
  });

  it("answers indexed: false for a folder nested under trash", async () => {
    const app = buildApp();

    const res = await app.request("/api/v1/fs/folder-size?path=/.trash/old");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/.trash/old", bytes: 0, files: 0, indexed: false });
  });
});
