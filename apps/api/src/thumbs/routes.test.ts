import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope, StorageProvider } from "@fdrive/core";
import type { Identity, IndexedFile, IndexQueries } from "@fdrive/db";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { ReadAuthorizer } from "../scoping/read-authorizer.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { buildIdentity } from "../scoping/test-fixtures/index.ts";
import { registerThumbRoutes, type ThumbFileReader, type ThumbRoutesDeps } from "./routes.js";

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

function fakeIndexQueries(overrides: Partial<IndexQueries> = {}): IndexQueries {
  return {
    semantic: overrides.semantic ?? (async () => fail("semantic")),
    fulltext: overrides.fulltext ?? (async () => fail("fulltext")),
    filename: overrides.filename ?? (async () => fail("filename")),
    filesByIds: overrides.filesByIds ?? (async () => fail("filesByIds")),
    fileByPath: overrides.fileByPath ?? (async () => fail("fileByPath")),
    listFiles: overrides.listFiles ?? (async () => fail("listFiles")),
    filesBySha256: overrides.filesBySha256 ?? (async () => fail("filesBySha256")),
    rootIdsByName: overrides.rootIdsByName ?? (async () => fail("rootIdsByName")),
    stats: overrides.stats ?? (async () => fail("stats")),
    statsForFileIds: overrides.statsForFileIds ?? (async () => fail("statsForFileIds")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    recordMove: overrides.recordMove ?? (async () => fail("recordMove")),
    recentMoves: overrides.recentMoves ?? (async () => fail("recentMoves")),
    deletedRowSha: overrides.deletedRowSha ?? (async () => fail("deletedRowSha")),
    liveRowsBySha: overrides.liveRowsBySha ?? (async () => fail("liveRowsBySha")),
    searchImages: overrides.searchImages ?? (async () => fail("searchImages")),
    imageEmbeddingStats: overrides.imageEmbeddingStats ?? (async () => fail("imageEmbeddingStats")),
    subtreeSize: overrides.subtreeSize ?? (async () => fail("subtreeSize")),
  };
}

function makeFile(overrides: Partial<IndexedFile> = {}): IndexedFile {
  return {
    id: 1,
    rootId: 1,
    path: "alice/photo.jpg",
    name: "photo.jpg",
    ext: ".jpg",
    size: 100,
    mtimeNs: 1n,
    sha256: "abc123",
    mime: null,
    textStatus: "done",
    textChars: 0,
    error: null,
    indexedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function fakeFileReader(overrides: Partial<ThumbFileReader> = {}): ThumbFileReader {
  return {
    stat: overrides.stat ?? (async () => ({ size: 42 })),
    readStream:
      overrides.readStream ??
      (() =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("webp-bytes"));
            controller.close();
          },
        })),
  };
}

/** Allows every target by default; pass `allow: false` to deny everything instead. */
function fakeAuthorizer(allow = true): ReadAuthorizer {
  return {
    authorize: async () => (allow ? { allowed: true } : { allowed: false, reason: "denied" }),
  };
}

interface BuildAppOptions extends Partial<Omit<ThumbRoutesDeps, "resolver" | "identities">> {
  /** Omits `fileReader` entirely so `registerThumbRoutes` falls back to the real, disk-backed one. */
  readonly useRealFileReader?: boolean;
  readonly scopes?: readonly Scope[] | null;
  readonly identity?: Identity | null;
  readonly authorizerAllows?: boolean;
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

  const { useRealFileReader, scopes, authorizerAllows, ...overrides } = deps;
  const resolvedScopes = scopes === undefined ? HOME_SCOPES : scopes;

  const resolver: Pick<ScopeResolver, "verifiedIndexScopes"> = {
    verifiedIndexScopes: async () =>
      resolvedScopes === null
        ? { available: false, reason: "no_roots" }
        : { available: true, scopes: resolvedScopes },
  };

  const fullDeps: ThumbRoutesDeps = {
    indexQueries: fakeIndexQueries(),
    resolver,
    identities: { get: async () => identity },
    thumbsDir: "/thumbs",
    createAuthorizer: () => fakeAuthorizer(authorizerAllows ?? true),
    ...(useRealFileReader === true ? {} : { fileReader: fakeFileReader() }),
    ...overrides,
  };

  return createApp({
    config: loadConfig(REQUIRED_ENV),
    logger: createTestLogger(),
    version: "1.0.0",
    startedAt: new Date("2024-06-01T00:00:00.000Z"),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerThumbRoutes(groups, fullDeps),
  });
}

describe("GET /api/v1/thumb: real file reader", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("streams an actual file from disk when no fileReader override is given", async () => {
    dir = await mkdtemp(join(tmpdir(), "fdrive-thumb-test-"));
    const storagePath = "ab/abc123.256.webp";
    await mkdir(join(dir, "ab"), { recursive: true });
    await writeFile(join(dir, storagePath), "real-webp-bytes");

    const app = buildApp({
      thumbsDir: dir,
      useRealFileReader: true,
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeFile(),
        thumbnail: async () => ({ storagePath }),
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("real-webp-bytes");
  });
});

describe("GET /api/v1/thumb", () => {
  it("streams a thumbnail with the expected headers", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("etag")).toBe('"abc123"');
    expect(await res.text()).toBe("webp-bytes");
  });

  it("returns 404 when thumbnails are not configured", async () => {
    const app = buildApp({ thumbsDir: undefined });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid size", async () => {
    const app = buildApp();

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=512");

    expect(res.status).toBe(400);
  });

  it("returns 400 for a path that fails to normalize", async () => {
    const app = buildApp();

    const res = await app.request(`/api/v1/thumb?path=${encodeURIComponent("a\0b")}&size=256`);

    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing path", async () => {
    const app = buildApp();

    const res = await app.request("/api/v1/thumb?size=256");

    expect(res.status).toBe(400);
  });

  it("returns 404 when the identity's verified scopes are unavailable", async () => {
    const app = buildApp({ scopes: null });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the caller's identity no longer exists", async () => {
    const app = buildApp({ identity: null });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the path cannot be resolved to a configured root", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({ rootIdsByName: async () => ({}) }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when no verified scope covers the requested path", async () => {
    const app = buildApp({
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/photos" }],
    });

    const res = await app.request("/api/v1/thumb?path=/videos/clip.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the file is not indexed", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => null,
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the indexed file has no sha256", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeFile({ sha256: null }),
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when no thumbnail has been generated for that size", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeFile(),
        thumbnail: async () => null,
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=1024");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the live read check denies the exact path", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      }),
      authorizerAllows: false,
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the cached thumbnail file is missing from disk", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      }),
      fileReader: fakeFileReader({
        stat: async () => {
          throw new Error("ENOENT");
        },
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("resolves the path under the caller's own scope, not another user's", async () => {
    const fileByPath = vi.fn(async () => makeFile({ path: "bob/photo.jpg" }));
    const app = buildApp(
      {
        indexQueries: fakeIndexQueries({
          rootIdsByName: async () => ({ sftpgo: 1 }),
          fileByPath,
          thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
        }),
        scopes: [{ rootName: "sftpgo", fsPrefix: "/bob", virtualPrefix: "/" }],
      },
      "bob",
    );

    await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(fileByPath).toHaveBeenCalledWith(1, "bob/photo.jpg");
  });

  it("uses the default authorizer built from the caller's own storage when none is injected", async () => {
    const download = vi.fn(async () => ({
      body: { cancel: async () => undefined } as unknown as ReadableStream<Uint8Array>,
      contentType: null,
      contentLength: null,
      lastModified: null,
    }));
    const storage = { list: async () => [], download } as unknown as StorageProvider;
    const identity = buildIdentity({ externalUsername: "alice" });
    const principal: Principal = {
      accountId: "00000000-0000-4000-8000-000000000001",
      identityId: identity.id,
      username: "alice",
      storage,
      isAdmin: false,
    };
    const deps: ThumbRoutesDeps = {
      indexQueries: fakeIndexQueries({
        rootIdsByName: async () => ({ sftpgo: 1 }),
        fileByPath: async () => makeFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      }),
      resolver: { verifiedIndexScopes: async () => ({ available: true, scopes: HOME_SCOPES }) },
      identities: { get: async () => identity },
      thumbsDir: "/thumbs",
      fileReader: fakeFileReader(),
    };
    const app = createApp({
      config: loadConfig(REQUIRED_ENV),
      logger: createTestLogger(),
      version: "1.0.0",
      startedAt: new Date("2024-06-01T00:00:00.000Z"),
      principalResolver: async () => principal,
      registerRoutes: (groups) => registerThumbRoutes(groups, deps),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(200);
    expect(download).toHaveBeenCalledWith("/photo.jpg");
  });
});
