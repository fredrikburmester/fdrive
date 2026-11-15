import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope, StorageProvider } from "@fdrive/core";
import type { IndexedFile, IndexQueries } from "@fdrive/db";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { registerThumbRoutes, type ThumbFileReader, type ThumbRoutesDeps } from "./routes.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_STORAGE_ROOT: "/srv/files",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const HOME_SCOPES: readonly Scope[] = [{ fsPrefix: "/alice", virtualPrefix: "/" }];

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
    folders: overrides.folders ?? (async () => fail("folders")),
    filesByIds: overrides.filesByIds ?? (async () => fail("filesByIds")),
    fileByPath: overrides.fileByPath ?? (async () => fail("fileByPath")),
    contentAt: overrides.contentAt ?? (async () => fail("contentAt")),
    listFiles: overrides.listFiles ?? (async () => fail("listFiles")),
    filesBySha256: overrides.filesBySha256 ?? (async () => fail("filesBySha256")),
    stats: overrides.stats ?? (async () => fail("stats")),
    statsForFileIds: overrides.statsForFileIds ?? (async () => fail("statsForFileIds")),
    fileTextPrefix: overrides.fileTextPrefix ?? (async () => fail("fileTextPrefix")),
    duplicates: overrides.duplicates ?? (async () => fail("duplicates")),
    similar: overrides.similar ?? (async () => fail("similar")),
    recentFiles: overrides.recentFiles ?? (async () => fail("recentFiles")),
    thumbnail: overrides.thumbnail ?? (async () => fail("thumbnail")),
    thumbnailKeys: overrides.thumbnailKeys ?? (async () => fail("thumbnailKeys")),
    searchImages: overrides.searchImages ?? (async () => fail("searchImages")),
    imageEmbeddingStats: overrides.imageEmbeddingStats ?? (async () => fail("imageEmbeddingStats")),
    photos: overrides.photos ?? (async () => fail("photos")),
    photoDetails: overrides.photoDetails ?? (async () => fail("photoDetails")),
    subtreeSize: overrides.subtreeSize ?? (async () => fail("subtreeSize")),
    bytesByExtension: overrides.bytesByExtension ?? (async () => fail("bytesByExtension")),
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

interface BuildAppOptions extends Partial<Omit<ThumbRoutesDeps, "resolver">> {
  /** Omits `fileReader` entirely so `registerThumbRoutes` falls back to the real, disk-backed one. */
  readonly useRealFileReader?: boolean;
  readonly scopes?: readonly Scope[] | null;
}

function buildApp(deps: BuildAppOptions = {}, username = "alice") {
  // The scope is the permission: a thumbnail reads nothing from storage.
  const storage = {} as StorageProvider;
  const principal: Principal = {
    accountId: "00000000-0000-4000-8000-000000000001",
    identityId: "00000000-0000-4000-8000-0000000000a1",
    username,
    storage,
    isAdmin: false,
  };

  const { useRealFileReader, scopes, ...overrides } = deps;
  const resolvedScopes = scopes === undefined ? HOME_SCOPES : scopes;

  const resolver: Pick<ScopeResolver, "scopesFor"> = {
    scopesFor: async () => resolvedScopes ?? [],
  };

  const fullDeps: ThumbRoutesDeps = {
    indexQueries: fakeIndexQueries(),
    resolver,
    thumbsDir: "/thumbs",
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
  it("blocks cached previews when presentation thumbnails are disabled", async () => {
    const app = buildApp({ enabled: async () => false });
    expect((await app.request("/api/v1/thumb?path=/photo.jpg&size=256")).status).toBe(404);
  });
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
        fileByPath: async () => makeFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toBe('"abc123"');
    expect(await res.text()).toBe("webp-bytes");
  });

  it("answers 304 without a body when the browser already has this file's thumbnail", async () => {
    const readStream = vi.fn(fakeFileReader().readStream);
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        fileByPath: async () => makeFile(),
        thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
      }),
      fileReader: fakeFileReader({ readStream }),
    });

    const same = await app.request("/api/v1/thumb?path=/photo.jpg&size=256", {
      headers: { "if-none-match": '"abc123"' },
    });
    expect(same.status).toBe(304);
    expect(same.headers.get("cache-control")).toBe("private, no-cache");
    expect(same.headers.get("etag")).toBe('"abc123"');
    expect(await same.text()).toBe("");
    expect(readStream).not.toHaveBeenCalled();

    // A changed file has another digest: its new thumbnail is sent.
    const changed = await app.request("/api/v1/thumb?path=/photo.jpg&size=256", {
      headers: { "if-none-match": '"old"' },
    });
    expect(changed.status).toBe(200);
  });

  it("returns 404 for fdrive's own folders, which nothing lists", async () => {
    const fileByPath = vi.fn(async () => makeFile());
    const app = buildApp({
      indexQueries: fakeIndexQueries({ fileByPath }),
    });

    for (const path of ["/.trash/photo.jpg", "/.fdrive-desktop/staging/photo.jpg"]) {
      const res = await app.request(`/api/v1/thumb?path=${encodeURIComponent(path)}&size=256`);
      expect(res.status).toBe(404);
    }
    expect(fileByPath).not.toHaveBeenCalled();
  });

  it("returns 404 for a path in the folder a shared folder shadows", async () => {
    const fileByPath = vi.fn(async () => makeFile());
    const app = buildApp({
      indexQueries: fakeIndexQueries({ fileByPath }),
      // bob's home holds a folder at alice's mount point: it maps to alice's
      // folder going in, so a path there never reaches bob's own copy.
      scopes: [
        { fsPrefix: "/bob", virtualPrefix: "/" },
        { fsPrefix: "/bob/Shared with me/docs", virtualPrefix: "/Inbox" },
      ],
    });

    const res = await app.request(
      `/api/v1/thumb?path=${encodeURIComponent("/Shared with me/docs/a.jpg")}&size=256`,
    );

    expect(res.status).toBe(404);
    expect(fileByPath).not.toHaveBeenCalled();
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

  it("returns 404 when no verified scope covers the requested path", async () => {
    const app = buildApp({
      scopes: [{ fsPrefix: "/alice", virtualPrefix: "/photos" }],
    });

    const res = await app.request("/api/v1/thumb?path=/videos/clip.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the file is not indexed", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        fileByPath: async () => null,
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the indexed file has no sha256", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        fileByPath: async () => makeFile({ sha256: null }),
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(res.status).toBe(404);
  });

  it("returns 404 when no thumbnail has been generated for that size", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
        fileByPath: async () => makeFile(),
        thumbnail: async () => null,
      }),
    });

    const res = await app.request("/api/v1/thumb?path=/photo.jpg&size=1024");

    expect(res.status).toBe(404);
  });

  it("returns 404 when the cached thumbnail file is missing from disk", async () => {
    const app = buildApp({
      indexQueries: fakeIndexQueries({
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
          fileByPath,
          thumbnail: async () => ({ storagePath: "ab/abc123.256.webp" }),
        }),
        scopes: [{ fsPrefix: "/bob", virtualPrefix: "/" }],
      },
      "bob",
    );

    await app.request("/api/v1/thumb?path=/photo.jpg&size=256");

    expect(fileByPath).toHaveBeenCalledWith(1, "bob/photo.jpg");
  });
});
