import {
  IndexerActionResponse,
  IndexerClearResponse,
  IndexerSettingsResponse,
  IndexerThumbnailsRebuildResponse,
  OcrOriginalRestoreResponse,
  OcrOriginalsResponse,
  OcrRunResponse,
  OcrSettingsResponse,
  SystemImageSearchResponse,
  SystemIndexerResponse,
  SystemLogsResponse,
  SystemOcrResponse,
  SystemReembedResponse,
  SystemSearchResponse,
  SystemThumbnailsResponse,
} from "@fdrive/contracts";
import type { IndexQueries } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { loadConfig } from "../config.js";
import type { IndexerClient } from "./indexer-client.js";
import type { OcrClient } from "./ocr-client.js";
import { changedSettingKeys, registerSystemRoutes, type SystemRoutesDeps } from "./routes.js";
import type { ThumbnailsRepo } from "./thumbnails-repo.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://localhost/fdrive",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
};

function notImplemented(): never {
  throw new Error("not implemented in this fake");
}

function fakeIndexQueries(overrides: Partial<IndexQueries> = {}): IndexQueries {
  return {
    semantic: notImplemented,
    fulltext: notImplemented,
    filename: notImplemented,
    filesByIds: notImplemented,
    fileByPath: notImplemented,
    listFiles: notImplemented,
    filesBySha256: notImplemented,
    rootIdsByName: async () => ({}),
    directoriesWithFiles: async () => [],
    stats: async () => ({ filesTracked: 0, byTextStatus: [], chunks: 0, chunksEmbedded: 0 }),
    statsForFileIds: async () => ({ chunks: 0, chunksEmbedded: 0 }),
    fileTextPrefix: async () => "",
    duplicates: notImplemented,
    similar: notImplemented,
    recentFiles: notImplemented,
    thumbnail: notImplemented,
    recordMove: notImplemented,
    recentMoves: notImplemented,
    deletedRowSha: notImplemented,
    liveRowsBySha: notImplemented,
    searchImages: notImplemented,
    imageEmbeddingStats: async () => ({ total: 0, model: null }),
    subtreeSize: notImplemented,
    ...overrides,
  };
}

function fakeThumbnailsRepo(count = 0): ThumbnailsRepo {
  return { count: async () => count };
}

function fakeIndexerClient(overrides: Partial<IndexerClient> = {}): IndexerClient {
  return {
    directory: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    health: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    stats: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    reindex: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    clearIndex: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    clearThumbnails: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    thumbnailsRebuild: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    imageEmbeddingsRebuild: async () => ({
      ok: false,
      reason: "unreachable",
      detail: "not stubbed",
    }),
    clearImageEmbeddings: async () => ({
      ok: false,
      reason: "unreachable",
      detail: "not stubbed",
    }),
    ...overrides,
  };
}

function fakeOcrClient(overrides: Partial<OcrClient> = {}): OcrClient {
  return {
    health: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    stats: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    run: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    originals: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    restoreOriginal: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    deleteOriginal: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    downloadOriginal: async () => ({ ok: false, detail: "not stubbed" }),
    ...overrides,
  };
}

interface RecordedEvent {
  subsystem: string;
  level: string;
  message: string;
  data: unknown;
}

function buildApp(opts: { isAdmin?: boolean; deps?: Partial<SystemRoutesDeps> }) {
  const config = loadConfig(REQUIRED_ENV);
  const repos = createMemoryRepos();
  const settings = repos.settings;
  const recorded: RecordedEvent[] = [];
  const deps: SystemRoutesDeps = {
    settings,
    systemEvents: repos.systemEvents,
    eventLog: {
      record: (subsystem, level, message, data) => {
        recorded.push({ subsystem, level, message, data });
      },
    },
    indexQueries: fakeIndexQueries(),
    thumbnailsRepo: fakeThumbnailsRepo(),
    indexerClient: null,
    ocrClient: null,
    embedUrl: undefined,
    imageEmbedClient: null,
    thumbsDir: undefined,
    indexRootNames: [],
    fetch: vi.fn() as unknown as typeof globalThis.fetch,
    ...opts.deps,
  };

  const principal: Principal = {
    accountId: "account-1",
    identityId: "identity-1",
    username: "alice",
    storage: {
      list: notImplemented,
      stat: notImplemented,
      statFile: notImplemented,
      download: notImplemented,
      upload: notImplemented,
      mkdir: notImplemented,
      move: notImplemented,
      copy: notImplemented,
      deleteFile: notImplemented,
      deleteDir: notImplemented,
      setModifiedAt: notImplemented,
      zip: notImplemented,
    },
    isAdmin: opts.isAdmin ?? true,
  };

  const app = createApp({
    config,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as never,
    version: "1.0.0",
    startedAt: new Date(0),
    connectionStatus: async () => ({
      required: false,
      providers: [{ type: "sftpgo", host: "sftpgo:8080" }],
    }),
    principalResolver: async () => principal,
    registerRoutes: (groups) => {
      registerSystemRoutes(groups, deps);
    },
  });

  return { app, settings, deps, recorded, systemEvents: repos.systemEvents };
}

describe("system routes: admin gate", () => {
  it("403s GET /system/indexer for a non-admin", async () => {
    const { app } = buildApp({ isAdmin: false });
    const res = await app.request("/api/v1/system/indexer");
    expect(res.status).toBe(403);
  });
});

describe("GET /system/indexer", () => {
  it("reports not configured when there is no indexer client", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/indexer");
    const body = SystemIndexerResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.reachable).toBe(false);
    expect(body.health).toBeUndefined();
    expect(body.stats).toBeUndefined();
    expect(body.settings.values.scanIntervalSeconds).toBe(900);
  });

  it("reports configured and reachable with health and stats when both succeed", async () => {
    const health = {
      ok: true,
      roots: ["sftpgo"],
      watcher: { sftpgo: true },
      embedOk: true,
      schemaVersion: 1,
    };
    const stats = { roots: [], thumbnails: 0, queueDepth: 0, errorsSample: [] };
    const indexerClient = fakeIndexerClient({
      health: async () => ({ ok: true, data: health }),
      stats: async () => ({ ok: true, data: stats }),
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/indexer");
    const body = SystemIndexerResponse.parse(await res.json());

    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.health).toEqual(health);
    expect(body.stats).toEqual(stats);
  });

  it("reports configured but unreachable when both calls fail", async () => {
    const indexerClient = fakeIndexerClient();
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/indexer");
    const body = SystemIndexerResponse.parse(await res.json());

    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(false);
    expect(body.health).toBeUndefined();
    expect(body.stats).toBeUndefined();
  });

  it("reports reachable when only one of health/stats succeeds", async () => {
    const stats = { roots: [], thumbnails: 0, queueDepth: 0, errorsSample: [] };
    const indexerClient = fakeIndexerClient({
      stats: async () => ({ ok: true, data: stats }),
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/indexer");
    const body = SystemIndexerResponse.parse(await res.json());

    expect(body.reachable).toBe(true);
    expect(body.health).toBeUndefined();
    expect(body.stats).toEqual(stats);
  });
});

describe("PUT /system/indexer/settings", () => {
  it("400s an invalid body", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/indexer/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ workers: 0 }),
    });

    expect(res.status).toBe(400);
  });

  it("400s a body that is not valid JSON", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/indexer/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("writes every key to settings and returns the resolved values", async () => {
    const { app, settings } = buildApp({});
    const patch = {
      scanIntervalSeconds: 60,
      workers: 2,
      textExcludeGlobs: ["**/tmp/**"],
      ocrImageGlobs: [],
      tesseractLangs: "eng",
    };

    const res = await app.request("/api/v1/system/indexer/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify(patch),
    });
    const body = IndexerSettingsResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body.values).toEqual(patch);
    expect(body.sources).toEqual({
      scanIntervalSeconds: "settings",
      workers: "settings",
      textExcludeGlobs: "settings",
      ocrImageGlobs: "settings",
      tesseractLangs: "settings",
    });
    expect(await settings.get("indexer.workers")).toBe(2);
  });
});

describe("POST /system/indexer/reindex", () => {
  it("400s when the indexer is not configured", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/indexer/reindex", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: "sftpgo" }),
    });

    expect(res.status).toBe(400);
  });

  it("400s an invalid body", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/indexer/reindex", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("400s a body that is not valid JSON", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/indexer/reindex", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("502s when the indexer is unreachable", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/indexer/reindex", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: "sftpgo" }),
    });

    expect(res.status).toBe(502);
  });

  it("returns marked on success", async () => {
    const indexerClient = fakeIndexerClient({
      reindex: async (root, path) => {
        expect(root).toBe("sftpgo");
        expect(path).toBe("folder");
        return { ok: true, data: { marked: 3 } };
      },
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/indexer/reindex", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: "sftpgo", path: "folder" }),
    });
    const body = IndexerActionResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body).toEqual({ marked: 3 });
  });
});

describe("POST /system/indexer/thumbnails/rebuild", () => {
  it("400s when the indexer is not configured", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/indexer/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(400);
  });

  it("400s an invalid body", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/indexer/thumbnails/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: 5 }),
    });

    expect(res.status).toBe(400);
  });

  it("502s when the indexer is unreachable", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/indexer/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(502);
  });

  it("returns started and total on success with no body", async () => {
    const indexerClient = fakeIndexerClient({
      thumbnailsRebuild: async (options) => {
        expect(options).toEqual({});
        return { ok: true, data: { started: true, total: 40 } };
      },
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/indexer/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });
    const body = IndexerThumbnailsRebuildResponse.parse(await res.json());

    expect(res.status).toBe(202);
    expect(body).toEqual({ started: true, total: 40 });
  });

  it("forwards root, path, and force", async () => {
    const indexerClient = fakeIndexerClient({
      thumbnailsRebuild: async (options) => {
        expect(options).toEqual({ root: "sftpgo", path: "folder", force: true });
        return { ok: true, data: { started: true, total: 2 } };
      },
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/indexer/thumbnails/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: "sftpgo", path: "folder", force: true }),
    });

    expect(res.status).toBe(202);
  });

  it("409s (conflict) when a rebuild is already running", async () => {
    const indexerClient = fakeIndexerClient({
      clearIndex: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
      clearThumbnails: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
      thumbnailsRebuild: async () => ({
        ok: false,
        reason: "unreachable",
        detail: "status 409",
        status: 409,
      }),
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/indexer/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(409);
  });
});

describe("GET /system/search", () => {
  it("reports not configured when there are no index roots", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/search");
    const body = SystemSearchResponse.parse(await res.json());

    expect(body.configured).toBe(false);
    expect(body.roots).toEqual([]);
    expect(body.semantic).toEqual({ configured: false, healthy: false });
  });

  it("reports index totals scoped to every configured root with fsPrefix /", async () => {
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({ sftpgo: 1, photos: 2 }),
      stats: async (scopePrefixes) => {
        expect(scopePrefixes).toEqual([
          { rootId: 1, fsPrefix: "/" },
          { rootId: 2, fsPrefix: "/" },
        ]);
        return {
          filesTracked: 10,
          byTextStatus: [
            { status: "indexed", files: 6, bytes: 100 },
            { status: "partial", files: 1, bytes: 10 },
            { status: "none", files: 3, bytes: 0 },
          ],
          chunks: 40,
          chunksEmbedded: 35,
        };
      },
    });
    const { app } = buildApp({ deps: { indexQueries, indexRootNames: ["sftpgo", "photos"] } });

    const res = await app.request("/api/v1/system/search");
    const body = SystemSearchResponse.parse(await res.json());

    expect(body.configured).toBe(true);
    expect(body.roots).toEqual(["sftpgo", "photos"]);
    expect(body.index).toEqual({ files: 10, withText: 7, chunks: 40, embedded: 35 });
  });

  it("skips a root name with no matching root id", async () => {
    const indexQueries = fakeIndexQueries({
      rootIdsByName: async () => ({}),
      stats: async (scopePrefixes) => {
        expect(scopePrefixes).toEqual([]);
        return { filesTracked: 0, byTextStatus: [], chunks: 0, chunksEmbedded: 0 };
      },
    });
    const { app } = buildApp({ deps: { indexQueries, indexRootNames: ["sftpgo"] } });

    const res = await app.request("/api/v1/system/search");
    expect(res.status).toBe(200);
  });

  it("reports semantic status from the embedding server", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health")) {
        return Promise.resolve(new Response("", { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ model_id: "m", max_input_length: 512 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const { app } = buildApp({ deps: { embedUrl: "http://embed:80", fetch: fetchImpl } });

    const res = await app.request("/api/v1/system/search");
    const body = SystemSearchResponse.parse(await res.json());

    expect(body.semantic).toEqual({
      configured: true,
      healthy: true,
      model: "m",
      maxInputLength: 512,
    });
  });
});

describe("GET /system/image-search", () => {
  it("reports not configured when there is no image-embed client", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/image-search");
    const body = SystemImageSearchResponse.parse(await res.json());

    expect(body).toEqual({
      configured: false,
      healthy: false,
      embedded: 0,
      embeddedModel: null,
    });
  });

  it("reports healthy with the model and dim when the sidecar's model is loaded", async () => {
    const imageEmbedClient = {
      health: async () => ({
        ok: true as const,
        data: { status: "ok" as const, model: "m", dim: 1024, device: "cpu" as const },
      }),
      embedText: async () => null,
    };
    const { app } = buildApp({ deps: { imageEmbedClient } });

    const res = await app.request("/api/v1/system/image-search");
    const body = SystemImageSearchResponse.parse(await res.json());

    expect(body.configured).toBe(true);
    expect(body.healthy).toBe(true);
    expect(body.model).toBe("m");
    expect(body.dim).toBe(1024);
  });

  it("reports configured but not healthy while the model is loading", async () => {
    const imageEmbedClient = {
      health: async () => ({
        ok: true as const,
        data: { status: "loading" as const, model: "m", dim: null, device: "cpu" as const },
      }),
      embedText: async () => null,
    };
    const { app } = buildApp({ deps: { imageEmbedClient } });

    const res = await app.request("/api/v1/system/image-search");
    const body = SystemImageSearchResponse.parse(await res.json());

    expect(body.configured).toBe(true);
    expect(body.healthy).toBe(false);
    expect(body.model).toBe("m");
    expect(body.dim).toBeUndefined();
    expect(body.status).toBe("loading");
  });

  it("reports configured but not healthy when the sidecar is unreachable", async () => {
    const imageEmbedClient = {
      health: async () => ({ ok: false as const, reason: "unreachable" as const, detail: "down" }),
      embedText: async () => null,
    };
    const { app } = buildApp({ deps: { imageEmbedClient } });

    const res = await app.request("/api/v1/system/image-search");
    const body = SystemImageSearchResponse.parse(await res.json());

    expect(body).toEqual({ configured: true, healthy: false, embedded: 0, embeddedModel: null });
  });

  it("reports embedded totals from the index", async () => {
    const indexQueries = fakeIndexQueries({
      imageEmbeddingStats: async () => ({ total: 12, model: "m" }),
    });
    const { app } = buildApp({ deps: { indexQueries } });

    const res = await app.request("/api/v1/system/image-search");
    const body = SystemImageSearchResponse.parse(await res.json());

    expect(body.embedded).toBe(12);
    expect(body.embeddedModel).toBe("m");
  });

  it("reports rebuild and clear jobs from the indexer's stats when present", async () => {
    const job = {
      running: false,
      processed: 4,
      total: 4,
      startedAt: "2026-01-01T00:00:00+00:00",
      finishedAt: "2026-01-01T00:01:00+00:00",
      errors: 0,
    };
    const indexerClient = fakeIndexerClient({
      stats: async () => ({
        ok: true,
        data: {
          roots: [],
          thumbnails: 0,
          queueDepth: 0,
          errorsSample: [],
          imageEmbeddingRebuild: job,
          imageEmbeddingClear: job,
        },
      }),
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/image-search");
    const body = SystemImageSearchResponse.parse(await res.json());

    expect(body.rebuild).toEqual(job);
    expect(body.clear).toEqual(job);
  });

  it("omits rebuild and clear when the indexer is not configured", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/image-search");
    const body = SystemImageSearchResponse.parse(await res.json());

    expect(body.rebuild).toBeUndefined();
    expect(body.clear).toBeUndefined();
  });
});

describe("POST /system/image-search/rebuild", () => {
  it("400s when the indexer is not configured", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/image-search/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(400);
  });

  it("400s an invalid body", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/image-search/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: 5 }),
    });

    expect(res.status).toBe(400);
  });

  it("returns started and total on success, forwarding options", async () => {
    const indexerClient = fakeIndexerClient({
      imageEmbeddingsRebuild: async (options) => {
        expect(options).toEqual({ root: "sftpgo", force: true });
        return { ok: true, data: { started: true, total: 7 } };
      },
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/image-search/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: "sftpgo", force: true }),
    });
    const body = IndexerThumbnailsRebuildResponse.parse(await res.json());

    expect(res.status).toBe(202);
    expect(body).toEqual({ started: true, total: 7 });
  });

  it("409s (conflict) when a rebuild is already running", async () => {
    const indexerClient = fakeIndexerClient({
      imageEmbeddingsRebuild: async () => ({
        ok: false,
        reason: "unreachable",
        detail: "status 409",
        status: 409,
      }),
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/image-search/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(409);
  });
});

describe("POST /system/image-search/clear", () => {
  it("400s when the indexer is not configured", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/image-search/clear", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(400);
  });

  it("400s a non-empty body", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/image-search/clear", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: "sftpgo" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns started on success", async () => {
    const indexerClient = fakeIndexerClient({
      clearImageEmbeddings: async () => ({ ok: true, data: { started: true } }),
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/image-search/clear", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });
    const body = IndexerClearResponse.parse(await res.json());

    expect(res.status).toBe(202);
    expect(body).toEqual({ started: true });
  });

  it("409s (conflict) when a clear or rebuild is already running", async () => {
    const indexerClient = fakeIndexerClient({
      clearImageEmbeddings: async () => ({
        ok: false,
        reason: "unreachable",
        detail: "status 409",
        status: 409,
      }),
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/image-search/clear", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(409);
  });
});

describe("POST /system/search/reembed", () => {
  it("400s when the indexer is not configured", async () => {
    const { app } = buildApp({ deps: { indexRootNames: ["sftpgo"] } });

    const res = await app.request("/api/v1/system/search/reembed", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(400);
  });

  it("400s when there are no index roots", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/search/reembed", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(400);
  });

  it("sums marked across every root", async () => {
    const seenRoots: string[] = [];
    const indexerClient = fakeIndexerClient({
      reindex: async (root) => {
        seenRoots.push(root);
        return { ok: true, data: { marked: root === "sftpgo" ? 3 : 5 } };
      },
    });
    const { app } = buildApp({
      deps: { indexerClient, indexRootNames: ["sftpgo", "photos"] },
    });

    const res = await app.request("/api/v1/system/search/reembed", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });
    const body = SystemReembedResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body).toEqual({ marked: 8, roots: ["sftpgo", "photos"] });
    expect(seenRoots).toEqual(["sftpgo", "photos"]);
  });

  it("502s as soon as one root fails", async () => {
    const indexerClient = fakeIndexerClient({
      reindex: async (root) =>
        root === "sftpgo"
          ? { ok: true, data: { marked: 1 } }
          : { ok: false, reason: "unreachable", detail: "boom" },
    });
    const { app } = buildApp({
      deps: { indexerClient, indexRootNames: ["sftpgo", "photos"] },
    });

    const res = await app.request("/api/v1/system/search/reembed", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(502);
  });
});

describe("GET /system/ocr", () => {
  it("reports not configured when there is no OCR client", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/ocr");
    const body = SystemOcrResponse.parse(await res.json());

    expect(body.configured).toBe(false);
    expect(body.reachable).toBe(false);
    expect(body.settings.values.hour).toBe(3);
  });

  it("reports configured and reachable with health and stats", async () => {
    const health = { ok: true, running: false };
    const stats = {
      lastRun: null,
      nextRunAt: null,
      scheduleHour: 3,
      langs: "swe+eng",
      excludeGlobs: [],
      maxMb: 200,
      keepOriginals: false,
      originalsRetentionDays: 0,
      originalsCount: 0,
      originalsBytes: 0,
      running: false,
    };
    const ocrClient = fakeOcrClient({
      health: async () => ({ ok: true, data: health }),
      stats: async () => ({ ok: true, data: stats }),
    });
    const { app } = buildApp({ deps: { ocrClient } });

    const res = await app.request("/api/v1/system/ocr");
    const body = SystemOcrResponse.parse(await res.json());

    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.health).toEqual(health);
    expect(body.stats).toEqual(stats);
  });

  it("reports unreachable when both calls fail", async () => {
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient() } });

    const res = await app.request("/api/v1/system/ocr");
    const body = SystemOcrResponse.parse(await res.json());

    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(false);
  });
});

describe("PUT /system/ocr/settings", () => {
  it("400s an invalid body", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/ocr/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ hour: 30 }),
    });

    expect(res.status).toBe(400);
  });

  it("400s a body that is not valid JSON", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/ocr/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("writes every key and returns the resolved values", async () => {
    const { app, settings } = buildApp({});
    const patch = {
      hour: 4,
      langs: "eng",
      excludeGlobs: [],
      maxMb: 100,
      keepOriginals: true,
      originalsRetentionDays: 90,
    };

    const res = await app.request("/api/v1/system/ocr/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify(patch),
    });
    const body = OcrSettingsResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body.values).toEqual(patch);
    expect(await settings.get("ocr.hour")).toBe(4);
  });
});

describe("POST /system/ocr/run", () => {
  it("400s when OCR is not configured", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/ocr/run", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(400);
  });

  it("502s when OCR is unreachable", async () => {
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient() } });

    const res = await app.request("/api/v1/system/ocr/run", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(502);
  });

  it("returns started:true on success", async () => {
    const ocrClient = fakeOcrClient({ run: async () => ({ ok: true, data: { started: true } }) });
    const { app } = buildApp({ deps: { ocrClient } });

    const res = await app.request("/api/v1/system/ocr/run", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });
    const body = OcrRunResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body).toEqual({ started: true });
  });
});

describe("GET /system/ocr/originals", () => {
  const original = {
    id: "0123456789abcdef_scan.pdf",
    root: "sftpgo",
    path: "docs/scan.pdf",
    size: 1024,
    keptAt: "2026-09-07T03:00:00.000Z",
    sha256: "a".repeat(64),
    legacy: false,
    state: "ocred" as const,
  };

  it("400s when OCR is not configured", async () => {
    const { app } = buildApp({});
    expect((await app.request("/api/v1/system/ocr/originals")).status).toBe(400);
  });

  it("lists kept originals", async () => {
    const originals = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [original], total: 1, offset: 0, limit: 50 } });
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient({ originals }) } });

    const res = await app.request("/api/v1/system/ocr/originals?query=scan&offset=0&limit=25");
    const body = OcrOriginalsResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body.items).toEqual([original]);
    expect(originals).toHaveBeenCalledWith({ query: "scan", offset: 0, limit: 25 });
  });

  it("rejects a page size beyond the cap", async () => {
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient() } });
    expect((await app.request("/api/v1/system/ocr/originals?limit=5000")).status).toBe(400);
  });

  it("502s when OCR is unreachable", async () => {
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient() } });
    expect((await app.request("/api/v1/system/ocr/originals")).status).toBe(502);
  });

  it("403s for a non-admin", async () => {
    const { app } = buildApp({ isAdmin: false, deps: { ocrClient: fakeOcrClient() } });
    expect((await app.request("/api/v1/system/ocr/originals")).status).toBe(403);
  });
});

describe("GET /system/ocr/originals/download", () => {
  it("streams the kept bytes as an attachment that is never cached", async () => {
    const downloadOriginal = vi
      .fn()
      .mockResolvedValue({ ok: true, response: new Response("pdf bytes") });
    const { app, recorded } = buildApp({
      deps: { ocrClient: fakeOcrClient({ downloadOriginal }) },
    });

    const res = await app.request("/api/v1/system/ocr/originals/download?id=abc_scan.pdf");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("pdf bytes");
    expect(recorded.map((event) => event.message)).toContain("Kept original downloaded");
  });

  it("400s without an id and 404s for one that is no longer kept", async () => {
    const downloadOriginal = vi
      .fn()
      .mockResolvedValue({ ok: false, detail: "status 404", status: 404 });
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient({ downloadOriginal }) } });

    expect((await app.request("/api/v1/system/ocr/originals/download")).status).toBe(400);
    expect((await app.request("/api/v1/system/ocr/originals/download?id=a")).status).toBe(404);
  });

  it("502s when the OCR service cannot be reached", async () => {
    const downloadOriginal = vi.fn().mockResolvedValue({ ok: false, detail: "refused" });
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient({ downloadOriginal }) } });
    expect((await app.request("/api/v1/system/ocr/originals/download?id=a")).status).toBe(502);
  });
});

describe("POST /system/ocr/originals/restore", () => {
  const post = (app: { request: typeof fetch }, body: unknown) =>
    app.request("/api/v1/system/ocr/originals/restore", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify(body),
    });

  it("restores and records what it replaced", async () => {
    const restoreOriginal = vi.fn().mockResolvedValue({
      ok: true,
      data: { restored: true, root: "sftpgo", path: "docs/scan.pdf", previousState: "ocred" },
    });
    const { app, recorded } = buildApp({ deps: { ocrClient: fakeOcrClient({ restoreOriginal }) } });

    const res = await post(app as never, { id: "abc_scan.pdf" });

    expect(res.status).toBe(200);
    expect(OcrOriginalRestoreResponse.parse(await res.json()).restored).toBe(true);
    expect(recorded).toContainEqual({
      subsystem: "ocr",
      level: "warn",
      message: "Original restored",
      data: { id: "abc_scan.pdf", root: "sftpgo", path: "docs/scan.pdf", replaced: "ocred" },
    });
  });

  it("turns a refusal into a 409 that names the reason and the state", async () => {
    const restoreOriginal = vi.fn().mockResolvedValue({
      ok: false,
      reason: "unreachable",
      detail: "status 409",
      status: 409,
      body: { error: "target_changed", state: "changed", root: "sftpgo", path: "docs/scan.pdf" },
    });
    const { app, recorded } = buildApp({ deps: { ocrClient: fakeOcrClient({ restoreOriginal }) } });

    const res = await post(app as never, { id: "abc_scan.pdf" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; details?: unknown } };
    expect(body.error.message).toContain("changed after OCR ran");
    expect(body.error.details).toMatchObject({ reason: "target_changed", state: "changed" });
    expect(recorded.map((event) => event.message)).toContain("Restore refused: target_changed");
  });

  it("turns an unknown original into a 404", async () => {
    const restoreOriginal = vi.fn().mockResolvedValue({
      ok: false,
      reason: "unreachable",
      detail: "status 404",
      status: 404,
      body: { error: "not_found" },
    });
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient({ restoreOriginal }) } });

    expect((await post(app as never, { id: "abc_scan.pdf" })).status).toBe(404);
  });

  it("502s when the failure carries no refusal to explain it", async () => {
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient() } });
    expect((await post(app as never, { id: "abc_scan.pdf" })).status).toBe(502);
  });

  it("400s on a body without an id, on one that is not JSON, and when OCR is not configured", async () => {
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient() } });
    expect((await post(app as never, { id: "" })).status).toBe(400);

    const malformed = await app.request("/api/v1/system/ocr/originals/restore", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "not json",
    });
    expect(malformed.status).toBe(400);

    const { app: unconfigured } = buildApp({});
    expect((await post(unconfigured as never, { id: "a" })).status).toBe(400);
  });
});

describe.each([
  ["target_changed", /changed after OCR ran/],
  ["target_missing", /no longer exists/],
  ["target_parent_missing", /folder that held that file no longer exists/],
  ["corrupt", /no longer matches its checksum/],
  ["unresolved", /could not be recovered/],
  ["unknown_root", /index root the OCR service is not configured for/],
  ["invalid_path", /source path outside its index root/],
  ["something_new", /refused that restore: something_new/],
])("a %s refusal", (reason, expected) => {
  it("is reported as a 409 an administrator can act on", async () => {
    const restoreOriginal = vi.fn().mockResolvedValue({
      ok: false,
      reason: "unreachable",
      detail: "status 409",
      status: 409,
      body: { error: reason, state: null, root: "sftpgo", path: "docs/scan.pdf" },
    });
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient({ restoreOriginal }) } });

    const res = await app.request("/api/v1/system/ocr/originals/restore", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ id: "abc_scan.pdf" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(expected);
  });
});

describe("POST /system/ocr/originals/delete", () => {
  const post = (app: { request: typeof fetch }, body: unknown) =>
    app.request("/api/v1/system/ocr/originals/delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify(body),
    });

  it("deletes and records it", async () => {
    const deleteOriginal = vi.fn().mockResolvedValue({ ok: true, data: { deleted: true } });
    const { app, recorded } = buildApp({ deps: { ocrClient: fakeOcrClient({ deleteOriginal }) } });

    const res = await post(app as never, { id: "abc_scan.pdf" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(recorded).toContainEqual({
      subsystem: "ocr",
      level: "warn",
      message: "Kept original deleted",
      data: { id: "abc_scan.pdf" },
    });
  });

  it("404s for an original that is already gone", async () => {
    const deleteOriginal = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "unreachable", detail: "status 404", status: 404 });
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient({ deleteOriginal }) } });

    expect((await post(app as never, { id: "abc_scan.pdf" })).status).toBe(404);
  });

  it("502s when OCR is unreachable, and 400s on a bad body or no OCR", async () => {
    const { app } = buildApp({ deps: { ocrClient: fakeOcrClient() } });
    expect((await post(app as never, { id: "abc_scan.pdf" })).status).toBe(502);

    const malformed = await app.request("/api/v1/system/ocr/originals/delete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: "not json",
    });
    expect(malformed.status).toBe(400);

    const { app: unconfigured } = buildApp({});
    expect((await post(unconfigured as never, { id: "a" })).status).toBe(400);
  });

  it("403s for a non-admin", async () => {
    const { app } = buildApp({ isAdmin: false, deps: { ocrClient: fakeOcrClient() } });
    expect((await post(app as never, { id: "abc_scan.pdf" })).status).toBe(403);
  });
});

describe("GET /system/thumbnails", () => {
  it("reports not configured with the db count but zero bytes when thumbsDir is unset", async () => {
    const { app } = buildApp({ deps: { thumbnailsRepo: fakeThumbnailsRepo(7) } });

    const res = await app.request("/api/v1/system/thumbnails");
    const body = SystemThumbnailsResponse.parse(await res.json());

    expect(body).toEqual({ configured: false, count: 7, bytes: 0 });
  });

  it("walks the thumbs directory for bytes when configured", async () => {
    const walkThumbnailBytes = vi.fn().mockResolvedValue({ bytes: 2048, filesWalked: 4 });
    const { app } = buildApp({
      deps: {
        thumbnailsRepo: fakeThumbnailsRepo(4),
        thumbsDir: "/thumbs",
        walkThumbnailBytes,
      },
    });

    const res = await app.request("/api/v1/system/thumbnails");
    const body = SystemThumbnailsResponse.parse(await res.json());

    expect(body).toEqual({ configured: true, count: 4, bytes: 2048 });
    expect(walkThumbnailBytes).toHaveBeenCalledWith("/thumbs", 200_000);
  });
});

describe("POST /system/thumbnails/rebuild", () => {
  it("400s when the indexer is not configured", async () => {
    const { app } = buildApp({});

    const res = await app.request("/api/v1/system/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(400);
  });

  it("502s when the indexer is unreachable", async () => {
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient() } });

    const res = await app.request("/api/v1/system/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(502);
  });

  it("returns started and total on success, rebuilding every root", async () => {
    const indexerClient = fakeIndexerClient({
      thumbnailsRebuild: async (options) => {
        expect(options).toBeUndefined();
        return { ok: true, data: { started: true, total: 99 } };
      },
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });
    const body = IndexerThumbnailsRebuildResponse.parse(await res.json());

    expect(res.status).toBe(202);
    expect(body).toEqual({ started: true, total: 99 });
  });

  it("409s (conflict) when a rebuild is already running", async () => {
    const indexerClient = fakeIndexerClient({
      clearIndex: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
      clearThumbnails: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
      thumbnailsRebuild: async () => ({
        ok: false,
        reason: "unreachable",
        detail: "status 409",
        status: 409,
      }),
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });

    expect(res.status).toBe(409);
  });
});

describe.each([
  ["indexer", "clearIndex"],
  ["thumbnails", "clearThumbnails"],
] as const)("POST /system/%s/clear", (area, method) => {
  const url = `/api/v1/system/${area}/clear`;

  it("rejects non-admins before calling the sidecar", async () => {
    const action = vi.fn();
    const { app } = buildApp({
      isAdmin: false,
      deps: { indexerClient: fakeIndexerClient({ [method]: action }) },
    });
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects actions without an indexer", async () => {
    const { app } = buildApp({});
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });

  it.each([undefined, "{}"])("accepts empty request %j", async (body) => {
    const action = vi.fn().mockResolvedValue({ ok: true, data: { started: true } });
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient({ [method]: action }) } });
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      ...(body === undefined ? {} : { body }),
    });
    expect(res.status).toBe(202);
    expect(IndexerClearResponse.parse(await res.json())).toEqual({ started: true });
    expect(action).toHaveBeenCalledWith(...(area === "indexer" ? [{}] : []));
  });

  it.each(["{", " ", "null", "[]", '"oops"', '{"root":2}', '{"path":"/"}', '{"unexpected":true}'])(
    "rejects invalid body %s without clearing",
    async (body) => {
      const action = vi.fn();
      const { app } = buildApp({
        deps: { indexerClient: fakeIndexerClient({ [method]: action }) },
      });
      expect(
        (
          await app.request(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
            body,
          })
        ).status,
      ).toBe(400);
      expect(action).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, 400],
    [404, 404],
    [409, 409],
    [500, 502],
    [undefined, 502],
  ])("maps upstream %s to %s", async (status, expected) => {
    const action = vi.fn().mockResolvedValue({
      ok: false,
      reason: "unreachable",
      detail: "failed",
      ...(status === undefined ? {} : { status }),
    });
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient({ [method]: action }) } });
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
          body: "{}",
        })
      ).status,
    ).toBe(expected);
  });
});

describe("clear scoping", () => {
  it.each([
    { root: "sftpgo" },
    { root: "sftpgo", path: "/" },
    { root: "sftpgo", path: "/folder/file.pdf" },
  ])("forwards index scope %j", async (scope) => {
    const clearIndex = vi.fn().mockResolvedValue({ ok: true, data: { started: true } });
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient({ clearIndex }) } });
    const res = await app.request("/api/v1/system/indexer/clear", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify(scope),
    });
    expect(res.status).toBe(202);
    expect(clearIndex).toHaveBeenCalledWith(scope);
  });

  it.each([{ root: "" }, { root: "r", path: "../file" }, { root: "r", path: "a/../file" }])(
    "rejects unsafe index scope %j",
    async (scope) => {
      const clearIndex = vi.fn();
      const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient({ clearIndex }) } });
      expect(
        (
          await app.request("/api/v1/system/indexer/clear", {
            method: "POST",
            headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
            body: JSON.stringify(scope),
          })
        ).status,
      ).toBe(400);
      expect(clearIndex).not.toHaveBeenCalled();
    },
  );

  it("rejects scoped thumbnail clears", async () => {
    const clearThumbnails = vi.fn();
    const { app } = buildApp({ deps: { indexerClient: fakeIndexerClient({ clearThumbnails }) } });
    expect(
      (
        await app.request("/api/v1/system/thumbnails/clear", {
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
          body: '{"root":"sftpgo"}',
        })
      ).status,
    ).toBe(400);
    expect(clearThumbnails).not.toHaveBeenCalled();
  });

  it("exposes clear progress in the indexer summary", async () => {
    const progress = {
      running: false,
      processed: 10,
      total: 10,
      errors: 1,
      startedAt: "2026-09-06T18:21:28+00:00",
      finishedAt: "2026-09-06T18:21:29+00:00",
    };
    const stats = {
      roots: [],
      thumbnails: 1,
      queueDepth: 0,
      errorsSample: [],
      indexClear: progress,
      thumbnailClear: progress,
    };
    const { app } = buildApp({
      deps: {
        indexerClient: fakeIndexerClient({ stats: async () => ({ ok: true, data: stats }) }),
      },
    });
    const res = await app.request("/api/v1/system/indexer");
    expect(SystemIndexerResponse.parse(await res.json()).stats).toEqual(stats);
  });
});

describe("GET /system/:subsystem/logs", () => {
  async function seed(
    events: { subsystem: string; level: "info" | "warn" | "error"; message: string }[],
  ) {
    const built = buildApp({});
    for (const event of events) {
      await built.systemEvents.append(event);
      // The in-memory log stamps `at` from the clock, so entries need
      // distinct instants for the `before` cursor to be meaningful.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return built;
  }

  it("403s for a non-admin", async () => {
    const { app } = buildApp({ isAdmin: false });
    const res = await app.request("/api/v1/system/indexer/logs");
    expect(res.status).toBe(403);
  });

  it("400s for a subsystem that has no log", async () => {
    const { app } = buildApp({});
    const res = await app.request("/api/v1/system/trash/logs");
    expect(res.status).toBe(400);
  });

  it("400s for an invalid query", async () => {
    const { app } = buildApp({});
    expect((await app.request("/api/v1/system/indexer/logs?limit=0")).status).toBe(400);
    expect((await app.request("/api/v1/system/indexer/logs?level=debug")).status).toBe(400);
    expect((await app.request("/api/v1/system/indexer/logs?before=nope")).status).toBe(400);
  });

  it("returns a subsystem's entries newest first, with data only when present", async () => {
    const { app, systemEvents } = buildApp({});
    await systemEvents.append({ subsystem: "indexer", level: "info", message: "older" });
    await systemEvents.append({
      subsystem: "indexer",
      level: "warn",
      message: "newer",
      data: { root: "sftpgo" },
    });
    await systemEvents.append({ subsystem: "ocr", level: "info", message: "other subsystem" });

    const res = await app.request("/api/v1/system/indexer/logs");
    const body = SystemLogsResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body.subsystem).toBe("indexer");
    expect(body.entries.map((entry) => entry.message)).toEqual(["newer", "older"]);
    expect(body.entries[0]).toMatchObject({
      level: "warn",
      source: "api",
      data: { root: "sftpgo" },
    });
    expect(body.entries[1]?.data).toBeUndefined();
    expect(body.nextCursor).toBeUndefined();
  });

  it("filters to the requested minimum level", async () => {
    const { app } = await seed([
      { subsystem: "search", level: "info", message: "i" },
      { subsystem: "search", level: "warn", message: "w" },
      { subsystem: "search", level: "error", message: "e" },
    ]);

    const res = await app.request("/api/v1/system/search/logs?level=warn");
    const body = SystemLogsResponse.parse(await res.json());

    expect(body.entries.map((entry) => entry.message)).toEqual(["e", "w"]);
  });

  it("clamps an over-large limit instead of rejecting it", async () => {
    const { app } = buildApp({});
    const res = await app.request("/api/v1/system/office/logs?limit=100000");
    expect(res.status).toBe(200);
  });

  it("offers a cursor for a full page and pages back with it", async () => {
    const { app } = await seed([
      { subsystem: "ocr", level: "info", message: "a" },
      { subsystem: "ocr", level: "info", message: "b" },
      { subsystem: "ocr", level: "info", message: "c" },
    ]);

    const first = SystemLogsResponse.parse(
      await (await app.request("/api/v1/system/ocr/logs?limit=2")).json(),
    );
    expect(first.entries.map((entry) => entry.message)).toEqual(["c", "b"]);
    expect(first.nextCursor).toBe(first.entries[1]?.at);

    const second = SystemLogsResponse.parse(
      await (
        await app.request(
          `/api/v1/system/ocr/logs?limit=2&before=${encodeURIComponent(first.nextCursor ?? "")}`,
        )
      ).json(),
    );
    expect(second.entries.map((entry) => entry.message)).toEqual(["a"]);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("system routes: recorded events", () => {
  it("records a settings update with the keys that actually changed", async () => {
    const { app, recorded } = buildApp({});

    const res = await app.request("/api/v1/system/indexer/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({
        scanIntervalSeconds: 60,
        workers: 4,
        textExcludeGlobs: [],
        ocrImageGlobs: ["**"],
        tesseractLangs: "swe+eng",
      }),
    });

    expect(res.status).toBe(200);
    expect(recorded).toEqual([
      {
        subsystem: "indexer",
        level: "info",
        message: "Settings updated",
        data: { changed: ["scanIntervalSeconds"] },
      },
    ]);
  });

  it("records an OCR settings update", async () => {
    const { app, recorded } = buildApp({});

    await app.request("/api/v1/system/ocr/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({
        hour: 4,
        langs: "swe+eng",
        excludeGlobs: [],
        maxMb: 200,
        keepOriginals: false,
        originalsRetentionDays: 0,
      }),
    });

    expect(recorded).toEqual([
      {
        subsystem: "ocr",
        level: "info",
        message: "Settings updated",
        data: { changed: ["hour", "excludeGlobs", "keepOriginals"] },
      },
    ]);
  });

  it("records a requested maintenance action, and clears as warnings", async () => {
    const indexerClient = fakeIndexerClient({
      reindex: async () => ({ ok: true, data: { marked: 1 } }),
      clearIndex: async () => ({ ok: true, data: { started: true } }),
      clearThumbnails: async () => ({ ok: true, data: { started: true } }),
      clearImageEmbeddings: async () => ({ ok: true, data: { started: true } }),
      thumbnailsRebuild: async () => ({ ok: true, data: { started: true, total: 1 } }),
      imageEmbeddingsRebuild: async () => ({ ok: true, data: { started: true, total: 1 } }),
    });
    const ocrClient = fakeOcrClient({ run: async () => ({ ok: true, data: { started: true } }) });
    const { app, recorded } = buildApp({
      deps: { indexerClient, ocrClient, indexRootNames: ["sftpgo"] },
    });
    const post = (path: string, body?: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    await post("/api/v1/system/indexer/reindex", { root: "sftpgo" });
    await post("/api/v1/system/thumbnails/rebuild");
    await post("/api/v1/system/indexer/thumbnails/rebuild", {});
    await post("/api/v1/system/image-search/rebuild", {});
    await post("/api/v1/system/ocr/run");
    await post("/api/v1/system/search/reembed");
    await post("/api/v1/system/indexer/clear", {});
    await post("/api/v1/system/thumbnails/clear", {});
    await post("/api/v1/system/image-search/clear", {});

    expect(recorded.map((event) => [event.subsystem, event.level, event.message])).toEqual([
      ["indexer", "info", "Reindex requested"],
      ["thumbnails", "info", "Thumbnail rebuild requested"],
      ["thumbnails", "info", "Thumbnail rebuild requested"],
      ["image-search", "info", "Image embedding rebuild requested"],
      ["ocr", "info", "OCR run requested"],
      ["search", "info", "Reembed requested"],
      ["indexer", "warn", "Index clear requested"],
      ["thumbnails", "warn", "Thumbnail clear requested"],
      ["image-search", "warn", "Image embedding clear requested"],
    ]);
    expect(recorded[0]?.data).toEqual({ root: "sftpgo" });
    expect(recorded[5]?.data).toEqual({ roots: ["sftpgo"] });
  });

  it("records an error for every sidecar action that fails", async () => {
    const failure = {
      ok: false as const,
      reason: "unreachable" as const,
      detail: "connect refused",
    };
    const indexerClient = fakeIndexerClient({
      reindex: async () => failure,
      clearIndex: async () => failure,
      clearThumbnails: async () => failure,
      clearImageEmbeddings: async () => failure,
      thumbnailsRebuild: async () => failure,
      imageEmbeddingsRebuild: async () => failure,
    });
    const ocrClient = fakeOcrClient({ run: async () => failure });
    const { app, recorded } = buildApp({
      deps: { indexerClient, ocrClient, indexRootNames: ["sftpgo"] },
    });
    const post = (path: string, body?: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    await post("/api/v1/system/indexer/reindex", { root: "sftpgo" });
    await post("/api/v1/system/thumbnails/rebuild");
    await post("/api/v1/system/indexer/thumbnails/rebuild", {});
    await post("/api/v1/system/image-search/rebuild", {});
    await post("/api/v1/system/ocr/run");
    await post("/api/v1/system/search/reembed");
    await post("/api/v1/system/indexer/clear", {});
    await post("/api/v1/system/thumbnails/clear", {});
    await post("/api/v1/system/image-search/clear", {});

    expect(recorded.every((event) => event.level === "error")).toBe(true);
    expect(recorded.map((event) => event.message)).toEqual([
      "Reindex failed: connect refused",
      "Thumbnail rebuild failed: connect refused",
      "Thumbnail rebuild failed: connect refused",
      "Image embedding rebuild failed: connect refused",
      "OCR run failed: connect refused",
      "Reembed failed: connect refused",
      "Index clear failed: connect refused",
      "Thumbnail clear failed: connect refused",
      "Image embedding clear failed: connect refused",
    ]);
  });
});

describe("changedSettingKeys", () => {
  it("compares by value, so an equal array counts as unchanged", () => {
    expect(changedSettingKeys({ a: 1, globs: ["**"] }, { a: 1, globs: ["**"] })).toEqual([]);
    expect(changedSettingKeys({ a: 1, globs: ["**"] }, { a: 2, globs: [] })).toEqual([
      "a",
      "globs",
    ]);
  });
});

it.each(["indexer/reindex", "search/reembed", "ocr/run"])(
  "preserves worker conflict for %s",
  async (route) => {
    const failure = {
      ok: false,
      reason: "unreachable",
      detail: "status 409",
      status: 409,
    } as const;
    const { app } = buildApp({
      deps: {
        indexRootNames: ["sftpgo"],
        indexerClient: fakeIndexerClient({ reindex: async () => failure }),
        ocrClient: fakeOcrClient({
          health: async () => failure,
          stats: async () => failure,
          run: async () => failure,
        }),
      },
    });
    const response = await app.request(`/api/v1/system/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
      body: JSON.stringify({ root: "sftpgo" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { kind: "conflict" } });
  },
);
