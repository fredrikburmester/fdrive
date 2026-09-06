import { describe, expect, it, vi } from "vitest";
import { createIndexerClient } from "./indexer-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const HEALTH_RAW = {
  ok: true,
  roots: ["sftpgo"],
  watcher: { sftpgo: true },
  embed_ok: true,
  schema_version: 3,
};

const STATS_RAW = {
  roots: [
    {
      root: "sftpgo",
      counts_by_status: { indexed: 5, pending: 1 },
      chunks: 20,
      chunks_embedded: 18,
      last_scan: {
        started_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:05:00.000Z",
        files_seen: 6,
        files_changed: 2,
        files_deleted: 0,
        errors: 0,
      },
    },
  ],
  thumbnails: 4,
  queue_depth: 1,
  errors_sample: [{ path: "a.pdf", error: "boom" }],
};

describe("createIndexerClient: health", () => {
  it("maps the raw snake_case health payload to camelCase", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, HEALTH_RAW));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    const result = await client.health();

    expect(result).toEqual({
      ok: true,
      data: {
        ok: true,
        roots: ["sftpgo"],
        watcher: { sftpgo: true },
        embedOk: true,
        schemaVersion: 3,
      },
    });
    expect(fetchStub).toHaveBeenCalledWith(
      "http://indexer:8010/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("passes through an unreachable result unmapped", async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error("refused"));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    expect(await client.health()).toEqual({
      ok: false,
      reason: "unreachable",
      detail: "refused",
    });
  });
});

describe("createIndexerClient: stats", () => {
  it("maps the raw stats payload, including a root's last scan", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, STATS_RAW));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    const result = await client.stats();

    expect(result).toEqual({
      ok: true,
      data: {
        roots: [
          {
            root: "sftpgo",
            countsByStatus: { indexed: 5, pending: 1 },
            chunks: 20,
            chunksEmbedded: 18,
            lastScan: {
              startedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:05:00.000Z",
              filesSeen: 6,
              filesChanged: 2,
              filesDeleted: 0,
              errors: 0,
            },
          },
        ],
        thumbnails: 4,
        queueDepth: 1,
        errorsSample: [{ path: "a.pdf", error: "boom" }],
      },
    });
  });

  it("maps thumbnail_rebuild to thumbnailRebuild when present", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ...STATS_RAW,
        thumbnail_rebuild: {
          running: true,
          processed: 2,
          total: 10,
          started_at: "2026-01-01T00:00:00+00:00",
          finished_at: null,
          errors: 1,
        },
      }),
    );
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    const result = await client.stats();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.thumbnailRebuild).toEqual({
      running: true,
      processed: 2,
      total: 10,
      startedAt: "2026-01-01T00:00:00+00:00",
      finishedAt: null,
      errors: 1,
    });
  });

  it("omits thumbnailRebuild when the indexer does not send it (older indexer)", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, STATS_RAW));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    const result = await client.stats();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.thumbnailRebuild).toBeUndefined();
  });

  it("maps a null last_scan through to a null lastScan", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        roots: [
          {
            root: "sftpgo",
            counts_by_status: {},
            chunks: 0,
            chunks_embedded: 0,
            last_scan: null,
          },
        ],
        thumbnails: 0,
        queue_depth: 0,
        errors_sample: [],
      }),
    );
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    const result = await client.stats();

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.roots[0]?.lastScan).toBeNull();
  });
});

describe("createIndexerClient: reindex", () => {
  it("posts { root } and maps count to marked", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { count: 12 }));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    const result = await client.reindex("sftpgo");

    expect(result).toEqual({ ok: true, data: { marked: 12 } });
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ root: "sftpgo" });
  });

  it("posts { root, path } when a path is given", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { count: 1 }));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    await client.reindex("sftpgo", "folder/sub");

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ root: "sftpgo", path: "folder/sub" });
  });

  it("posts { root, thumbnails: true } when a thumbnail rebuild is also requested", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, { count: 1 }));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    await client.reindex("sftpgo", undefined, true);

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ root: "sftpgo", thumbnails: true });
  });
});

describe("createIndexerClient: thumbnailsRebuild", () => {
  it("posts an empty body when no options are given", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(202, { started: true, total: 40 }));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    const result = await client.thumbnailsRebuild();

    expect(result).toEqual({ ok: true, data: { started: true, total: 40 } });
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("scopes the request to a root, path, and force when given", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(202, { started: true, total: 5 }));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    await client.thumbnailsRebuild({ root: "sftpgo", path: "folder", force: true });

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ root: "sftpgo", path: "folder", force: true });
  });

  it("carries the sidecar's status through on failure (e.g. 409 already running)", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(409, { error: "already running" }));
    const client = createIndexerClient({ baseUrl: "http://indexer:8010", fetch: fetchStub });

    const result = await client.thumbnailsRebuild();

    expect(result).toEqual({
      ok: false,
      reason: "unreachable",
      detail: "status 409",
      status: 409,
    });
  });
});
