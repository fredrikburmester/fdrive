import {
  IndexerActionResponse,
  IndexerSettingsResponse,
  OcrRunResponse,
  OcrSettingsResponse,
  SystemIndexerResponse,
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
import { registerSystemRoutes, type SystemRoutesDeps } from "./routes.js";
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
    stats: async () => ({ filesTracked: 0, byTextStatus: [], chunks: 0, chunksEmbedded: 0 }),
    duplicates: notImplemented,
    similar: notImplemented,
    recentFiles: notImplemented,
    thumbnail: notImplemented,
    recordMove: notImplemented,
    recentMoves: notImplemented,
    ...overrides,
  };
}

function fakeThumbnailsRepo(count = 0): ThumbnailsRepo {
  return { count: async () => count };
}

function fakeIndexerClient(overrides: Partial<IndexerClient> = {}): IndexerClient {
  return {
    health: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    stats: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    reindex: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    thumbnailsRebuild: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    ...overrides,
  };
}

function fakeOcrClient(overrides: Partial<OcrClient> = {}): OcrClient {
  return {
    health: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    stats: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    run: async () => ({ ok: false, reason: "unreachable", detail: "not stubbed" }),
    ...overrides,
  };
}

function buildApp(opts: { isAdmin?: boolean; deps?: Partial<SystemRoutesDeps> }) {
  const config = loadConfig(REQUIRED_ENV);
  const settings = createMemoryRepos().settings;
  const deps: SystemRoutesDeps = {
    settings,
    indexQueries: fakeIndexQueries(),
    thumbnailsRepo: fakeThumbnailsRepo(),
    indexerClient: null,
    ocrClient: null,
    embedUrl: undefined,
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
    connectionStatus: async () => ({ required: false, host: "sftpgo:8080" }),
    principalResolver: async () => principal,
    registerRoutes: (groups) => {
      registerSystemRoutes(groups, deps);
    },
  });

  return { app, settings, deps };
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

  it("returns marked on success with no body", async () => {
    const indexerClient = fakeIndexerClient({
      thumbnailsRebuild: async (root) => {
        expect(root).toBeUndefined();
        return { ok: true, data: { marked: 40 } };
      },
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/indexer/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });
    const body = IndexerActionResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body).toEqual({ marked: 40 });
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
    const patch = { hour: 4, langs: "eng", excludeGlobs: [], maxMb: 100, keepOriginals: true };

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

  it("returns marked on success, rebuilding every root", async () => {
    const indexerClient = fakeIndexerClient({
      thumbnailsRebuild: async (root) => {
        expect(root).toBeUndefined();
        return { ok: true, data: { marked: 99 } };
      },
    });
    const { app } = buildApp({ deps: { indexerClient } });

    const res = await app.request("/api/v1/system/thumbnails/rebuild", {
      method: "POST",
      headers: { "x-requested-with": "fdrive" },
    });
    const body = IndexerActionResponse.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body).toEqual({ marked: 99 });
  });
});
