import { describe, expect, it } from "vitest";
import {
  IndexerActionResponse,
  IndexerClearJob,
  IndexerClearRequest,
  IndexerClearResponse,
  IndexerErrorSample,
  IndexerHealth,
  IndexerLastScan,
  IndexerReindexRequest,
  IndexerRootStats,
  IndexerSettingsResponse,
  IndexerSettingsUpdateRequest,
  IndexerStats,
  IndexerThumbnailRebuildJob,
  IndexerThumbnailsRebuildRequest,
  IndexerThumbnailsRebuildResponse,
  OcrHealth,
  OcrLastRun,
  OcrRunResponse,
  OcrSettingsResponse,
  OcrSettingsUpdateRequest,
  OcrStats,
  SemanticStatus,
  SettingSource,
  SystemImageSearchResponse,
  SystemIndexerResponse,
  SystemIndexTotals,
  SystemOcrResponse,
  SystemReembedResponse,
  SystemSearchResponse,
  SystemThumbnailsResponse,
} from "./system";

describe("SettingSource", () => {
  it("accepts default and settings", () => {
    expect(SettingSource.safeParse("default").success).toBe(true);
    expect(SettingSource.safeParse("settings").success).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(SettingSource.safeParse("env").success).toBe(false);
  });
});

describe("IndexerHealth", () => {
  const valid = {
    ok: true,
    roots: ["sftpgo"],
    watcher: { sftpgo: true },
    embedOk: true,
    schemaVersion: 3,
  };

  it("parses a valid payload", () => {
    expect(IndexerHealth.parse(valid)).toEqual(valid);
  });

  it("accepts a null schemaVersion", () => {
    expect(IndexerHealth.safeParse({ ...valid, schemaVersion: null }).success).toBe(true);
  });

  it("rejects a missing watcher map", () => {
    const { watcher: _drop, ...rest } = valid;
    expect(IndexerHealth.safeParse(rest).success).toBe(false);
  });
});

describe("IndexerLastScan", () => {
  const valid = {
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:05:00.000Z",
    filesSeen: 10,
    filesChanged: 2,
    filesDeleted: 0,
    errors: 0,
  };

  it("parses a valid payload", () => {
    expect(IndexerLastScan.parse(valid)).toEqual(valid);
  });

  it("accepts a null finishedAt (scan in progress)", () => {
    expect(IndexerLastScan.safeParse({ ...valid, finishedAt: null }).success).toBe(true);
  });

  it("rejects a non-datetime startedAt", () => {
    expect(IndexerLastScan.safeParse({ ...valid, startedAt: "not a date" }).success).toBe(false);
  });

  it("accepts the indexer's Python isoformat +00:00 offset (not a Z suffix)", () => {
    const pythonIsoformat = {
      ...valid,
      startedAt: "2026-09-06T18:21:28.128513+00:00",
      finishedAt: "2026-09-06T18:21:28.141420+00:00",
    };
    expect(IndexerLastScan.safeParse(pythonIsoformat).success).toBe(true);
  });
});

describe("IndexerRootStats", () => {
  it("parses a valid payload with a null lastScan", () => {
    const valid = {
      root: "sftpgo",
      countsByStatus: { indexed: 5, pending: 1 },
      chunks: 20,
      chunksEmbedded: 18,
      lastScan: null,
    };
    expect(IndexerRootStats.parse(valid)).toEqual(valid);
  });
});

describe("IndexerErrorSample", () => {
  it("accepts a null error message", () => {
    expect(IndexerErrorSample.safeParse({ path: "a.pdf", error: null }).success).toBe(true);
  });
});

describe("IndexerStats", () => {
  it("parses a valid payload", () => {
    const valid = {
      roots: [],
      thumbnails: 4,
      queueDepth: 0,
      errorsSample: [{ path: "a.pdf", error: "boom" }],
    };
    expect(IndexerStats.parse(valid)).toEqual(valid);
  });

  it("parses without thumbnailRebuild (older indexer)", () => {
    const valid = { roots: [], thumbnails: 0, queueDepth: 0, errorsSample: [] };
    const result = IndexerStats.parse(valid);
    expect(result.thumbnailRebuild).toBeUndefined();
  });

  it("parses with a thumbnailRebuild job", () => {
    const valid = {
      roots: [],
      thumbnails: 0,
      queueDepth: 0,
      errorsSample: [],
      thumbnailRebuild: {
        running: true,
        processed: 2,
        total: 10,
        startedAt: "2026-09-06T18:21:28.128513+00:00",
        finishedAt: null,
        errors: 0,
      },
    };
    expect(IndexerStats.parse(valid)).toEqual(valid);
  });

  it("parses with imageEmbeddings and image-embedding jobs", () => {
    const valid = {
      roots: [],
      thumbnails: 0,
      queueDepth: 0,
      errorsSample: [],
      imageEmbeddings: 12,
      imageEmbeddingRebuild: {
        running: false,
        processed: 12,
        total: 12,
        startedAt: "2026-09-06T18:21:28.128513+00:00",
        finishedAt: "2026-09-06T18:22:00.000000+00:00",
        errors: 0,
      },
      imageEmbeddingClear: {
        running: false,
        processed: 0,
        total: 0,
        startedAt: null,
        finishedAt: null,
        errors: 0,
      },
    };
    expect(IndexerStats.parse(valid)).toEqual(valid);
  });
});

describe("IndexerThumbnailRebuildJob", () => {
  const valid = {
    running: false,
    processed: 3,
    total: 3,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    errors: 0,
  };

  it("parses a valid payload", () => {
    expect(IndexerThumbnailRebuildJob.parse(valid)).toEqual(valid);
  });

  it("accepts null startedAt and finishedAt (never run)", () => {
    expect(
      IndexerThumbnailRebuildJob.safeParse({ ...valid, startedAt: null, finishedAt: null }).success,
    ).toBe(true);
  });
});

describe("IndexerSettingsResponse", () => {
  it("parses a valid payload", () => {
    const valid = {
      values: {
        scanIntervalSeconds: 900,
        workers: 4,
        textExcludeGlobs: ["**/tmp/**"],
        ocrImageGlobs: ["**/scans/**"],
        tesseractLangs: "swe+eng",
      },
      sources: {
        scanIntervalSeconds: "default",
        workers: "settings",
        textExcludeGlobs: "default",
        ocrImageGlobs: "default",
        tesseractLangs: "default",
      },
    };
    expect(IndexerSettingsResponse.parse(valid)).toEqual(valid);
  });
});

describe("SystemIndexerResponse", () => {
  const settings = {
    values: {
      scanIntervalSeconds: 900,
      workers: 4,
      textExcludeGlobs: [],
      ocrImageGlobs: [],
      tesseractLangs: "swe+eng",
    },
    sources: {
      scanIntervalSeconds: "default",
      workers: "default",
      textExcludeGlobs: "default",
      ocrImageGlobs: "default",
      tesseractLangs: "default",
    },
  };

  it("parses the not-configured shape (no health, no stats)", () => {
    const valid = { configured: false, reachable: false, settings };
    expect(SystemIndexerResponse.parse(valid)).toEqual(valid);
  });

  it("parses the configured-and-reachable shape", () => {
    const valid = {
      configured: true,
      reachable: true,
      health: {
        ok: true,
        roots: ["sftpgo"],
        watcher: { sftpgo: true },
        embedOk: true,
        schemaVersion: 1,
      },
      stats: { roots: [], thumbnails: 0, queueDepth: 0, errorsSample: [] },
      settings,
    };
    expect(SystemIndexerResponse.parse(valid)).toEqual(valid);
  });
});

describe("IndexerSettingsUpdateRequest", () => {
  const valid = {
    scanIntervalSeconds: 900,
    workers: 4,
    textExcludeGlobs: ["**/tmp/**"],
    ocrImageGlobs: [],
    tesseractLangs: "swe+eng",
  };

  it("accepts a valid payload", () => {
    expect(IndexerSettingsUpdateRequest.safeParse(valid).success).toBe(true);
  });

  it("rejects a scanIntervalSeconds below 30", () => {
    expect(
      IndexerSettingsUpdateRequest.safeParse({ ...valid, scanIntervalSeconds: 10 }).success,
    ).toBe(false);
  });

  it("rejects a scanIntervalSeconds above 86400", () => {
    expect(
      IndexerSettingsUpdateRequest.safeParse({ ...valid, scanIntervalSeconds: 100_000 }).success,
    ).toBe(false);
  });

  it("rejects workers below 1", () => {
    expect(IndexerSettingsUpdateRequest.safeParse({ ...valid, workers: 0 }).success).toBe(false);
  });

  it("rejects workers above 16", () => {
    expect(IndexerSettingsUpdateRequest.safeParse({ ...valid, workers: 17 }).success).toBe(false);
  });

  it("rejects an empty-string glob entry", () => {
    expect(
      IndexerSettingsUpdateRequest.safeParse({ ...valid, textExcludeGlobs: [""] }).success,
    ).toBe(false);
  });

  it("rejects an empty tesseractLangs", () => {
    expect(IndexerSettingsUpdateRequest.safeParse({ ...valid, tesseractLangs: "" }).success).toBe(
      false,
    );
  });
});

describe("IndexerReindexRequest", () => {
  it("accepts a root with no path", () => {
    expect(IndexerReindexRequest.safeParse({ root: "sftpgo" }).success).toBe(true);
  });

  it("accepts a root with a path", () => {
    expect(IndexerReindexRequest.safeParse({ root: "sftpgo", path: "folder" }).success).toBe(true);
  });

  it("accepts a thumbnails flag", () => {
    const result = IndexerReindexRequest.safeParse({ root: "sftpgo", thumbnails: true });
    expect(result.success).toBe(true);
  });

  it("rejects an empty root", () => {
    expect(IndexerReindexRequest.safeParse({ root: "" }).success).toBe(false);
  });
});

describe("IndexerThumbnailsRebuildRequest", () => {
  it("accepts an empty body", () => {
    expect(IndexerThumbnailsRebuildRequest.safeParse({}).success).toBe(true);
  });

  it("accepts a root", () => {
    expect(IndexerThumbnailsRebuildRequest.safeParse({ root: "sftpgo" }).success).toBe(true);
  });

  it("accepts a path and force", () => {
    const result = IndexerThumbnailsRebuildRequest.safeParse({
      root: "sftpgo",
      path: "folder",
      force: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty path", () => {
    expect(IndexerThumbnailsRebuildRequest.safeParse({ path: "" }).success).toBe(false);
  });
});

describe("IndexerThumbnailsRebuildResponse", () => {
  it("parses a valid payload", () => {
    const valid = { started: true, total: 12 };
    expect(IndexerThumbnailsRebuildResponse.parse(valid)).toEqual(valid);
  });

  it("accepts started: false with a zero total (already running)", () => {
    expect(IndexerThumbnailsRebuildResponse.safeParse({ started: false, total: 0 }).success).toBe(
      true,
    );
  });
});

describe("IndexerActionResponse", () => {
  it("parses a valid payload", () => {
    expect(IndexerActionResponse.parse({ marked: 12 })).toEqual({ marked: 12 });
  });
});

describe("SemanticStatus", () => {
  it("parses a minimal not-configured payload", () => {
    expect(SemanticStatus.parse({ configured: false, healthy: false })).toEqual({
      configured: false,
      healthy: false,
    });
  });

  it("parses a full payload", () => {
    const valid = {
      configured: true,
      healthy: true,
      model: "intfloat/multilingual-e5-small",
      maxInputLength: 512,
    };
    expect(SemanticStatus.parse(valid)).toEqual(valid);
  });
});

describe("SystemIndexTotals", () => {
  it("parses a valid payload", () => {
    const valid = { files: 10, withText: 8, chunks: 40, embedded: 40 };
    expect(SystemIndexTotals.parse(valid)).toEqual(valid);
  });
});

describe("SystemSearchResponse", () => {
  it("parses a valid payload", () => {
    const valid = {
      configured: true,
      semantic: { configured: true, healthy: true },
      roots: ["sftpgo"],
      index: { files: 1, withText: 1, chunks: 1, embedded: 1 },
    };
    expect(SystemSearchResponse.parse(valid)).toEqual(valid);
  });
});

describe("SystemReembedResponse", () => {
  it("parses a valid payload", () => {
    expect(SystemReembedResponse.parse({ marked: 5, roots: ["sftpgo"] })).toEqual({
      marked: 5,
      roots: ["sftpgo"],
    });
  });
});

describe("SystemImageSearchResponse", () => {
  it("parses a fully configured and healthy payload", () => {
    const valid = {
      configured: true,
      healthy: true,
      model: "google/siglip2-large-patch16-256",
      dim: 1024,
      embedded: 12,
      embeddedModel: "google/siglip2-large-patch16-256",
      rebuild: {
        running: false,
        processed: 12,
        total: 12,
        startedAt: "2026-09-06T18:21:28.128513+00:00",
        finishedAt: "2026-09-06T18:22:00.000000+00:00",
        errors: 0,
      },
      clear: {
        running: false,
        processed: 0,
        total: 0,
        startedAt: null,
        finishedAt: null,
        errors: 0,
      },
    };
    expect(SystemImageSearchResponse.parse(valid)).toEqual(valid);
  });

  it("parses an unconfigured payload without model, dim, rebuild, or clear", () => {
    const valid = { configured: false, healthy: false, embedded: 0, embeddedModel: null };
    expect(SystemImageSearchResponse.safeParse(valid).success).toBe(true);
  });
});

describe("OcrHealth", () => {
  it("parses a valid payload", () => {
    expect(OcrHealth.parse({ ok: true, running: false })).toEqual({ ok: true, running: false });
  });
});

describe("OcrLastRun", () => {
  const valid = {
    startedAt: "2026-01-01T03:00:00.000Z",
    finishedAt: "2026-01-01T03:10:00.000Z",
    seen: 100,
    ocred: 5,
    skipped: 94,
    failed: 1,
  };

  it("parses a valid payload", () => {
    expect(OcrLastRun.parse(valid)).toEqual(valid);
  });

  it("accepts the OCR service's Python isoformat +00:00 offset (not a Z suffix)", () => {
    const pythonIsoformat = {
      ...valid,
      startedAt: "2026-09-06T03:00:00.000000+00:00",
      finishedAt: "2026-09-06T03:10:00.000000+00:00",
    };
    expect(OcrLastRun.safeParse(pythonIsoformat).success).toBe(true);
  });
});

describe("OcrStats", () => {
  it("parses a valid payload with a null lastRun and nextRunAt", () => {
    const valid = {
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
    expect(OcrStats.parse(valid)).toEqual(valid);
  });

  it("rejects a scheduleHour above 23", () => {
    const valid = {
      lastRun: null,
      nextRunAt: null,
      scheduleHour: 24,
      langs: "swe+eng",
      excludeGlobs: [],
      maxMb: 200,
      keepOriginals: false,
      originalsCount: 0,
      originalsBytes: 0,
      running: false,
    };
    expect(OcrStats.safeParse(valid).success).toBe(false);
  });

  it("accepts a nextRunAt with a +00:00 offset", () => {
    const valid = {
      lastRun: null,
      nextRunAt: "2026-09-07T03:00:00+00:00",
      scheduleHour: 3,
      langs: "swe+eng",
      excludeGlobs: [],
      maxMb: 200,
      keepOriginals: false,
      originalsCount: 0,
      originalsBytes: 0,
      running: false,
    };
    expect(OcrStats.safeParse(valid).success).toBe(true);
  });
});

describe("OcrSettingsResponse", () => {
  it("parses a valid payload", () => {
    const valid = {
      values: {
        hour: 3,
        langs: "swe+eng",
        excludeGlobs: [],
        maxMb: 200,
        keepOriginals: false,
      },
      sources: {
        hour: "default",
        langs: "default",
        excludeGlobs: "default",
        maxMb: "default",
        keepOriginals: "default",
      },
    };
    expect(OcrSettingsResponse.parse(valid)).toEqual(valid);
  });
});

describe("SystemOcrResponse", () => {
  const settings = {
    values: { hour: 3, langs: "swe+eng", excludeGlobs: [], maxMb: 200, keepOriginals: false },
    sources: {
      hour: "default",
      langs: "default",
      excludeGlobs: "default",
      maxMb: "default",
      keepOriginals: "default",
    },
  };

  it("parses the not-configured shape", () => {
    expect(SystemOcrResponse.parse({ configured: false, reachable: false, settings })).toEqual({
      configured: false,
      reachable: false,
      settings,
    });
  });
});

describe("OcrSettingsUpdateRequest", () => {
  const valid = {
    hour: 3,
    langs: "swe+eng",
    excludeGlobs: ["**/private/**"],
    maxMb: 200,
    keepOriginals: true,
  };

  it("accepts a valid payload", () => {
    expect(OcrSettingsUpdateRequest.safeParse(valid).success).toBe(true);
  });

  it("rejects an hour above 23", () => {
    expect(OcrSettingsUpdateRequest.safeParse({ ...valid, hour: 24 }).success).toBe(false);
  });

  it("rejects an hour below 0", () => {
    expect(OcrSettingsUpdateRequest.safeParse({ ...valid, hour: -1 }).success).toBe(false);
  });

  it("rejects an empty langs", () => {
    expect(OcrSettingsUpdateRequest.safeParse({ ...valid, langs: "" }).success).toBe(false);
  });

  it("rejects a maxMb below 1", () => {
    expect(OcrSettingsUpdateRequest.safeParse({ ...valid, maxMb: 0 }).success).toBe(false);
  });
});

describe("OcrRunResponse", () => {
  it("parses a valid payload", () => {
    expect(OcrRunResponse.parse({ started: true })).toEqual({ started: true });
  });
});

describe("SystemThumbnailsResponse", () => {
  it("parses a valid payload", () => {
    const valid = { configured: true, count: 42, bytes: 1024 };
    expect(SystemThumbnailsResponse.parse(valid)).toEqual(valid);
  });

  it("rejects a negative count", () => {
    expect(
      SystemThumbnailsResponse.safeParse({ configured: true, count: -1, bytes: 0 }).success,
    ).toBe(false);
  });
});

describe("clear contracts", () => {
  it.each([
    {},
    { root: "sftpgo" },
    { root: "sftpgo", path: "/" },
    { root: "sftpgo", path: "/a/b.pdf" },
    { root: "sftpgo", path: "a_%/file.pdf" },
  ])("accepts scope %j", (scope) => {
    expect(IndexerClearRequest.parse(scope)).toEqual(scope);
  });

  it.each([
    null,
    [],
    { root: "" },
    { root: " " },
    { root: 2 },
    { path: "/a" },
    { root: "r", path: "" },
    { root: "r", path: "../a" },
    { root: "r", path: "a/../b" },
    { root: "r", path: "a\n/../b" },
    { root: "r", path: "a\\..\\b" },
    { root: "r", path: "a\0b" },
    { root: "r", path: ".." },
    { root: "r", path: "a\\b" },
    { force: true },
  ])("rejects unsafe scope %j", (scope) => {
    expect(IndexerClearRequest.safeParse(scope).success).toBe(false);
  });

  it("parses clear admission and progress with Python timestamps", () => {
    expect(IndexerClearResponse.parse({ started: true })).toEqual({ started: true });
    expect(IndexerClearResponse.safeParse({ started: 1 }).success).toBe(false);
    const progress = {
      running: false,
      processed: 3,
      total: 4,
      errors: 1,
      startedAt: "2026-09-06T18:21:28+00:00",
      finishedAt: null,
    };
    expect(IndexerClearJob.parse(progress)).toEqual(progress);
    expect(
      IndexerStats.parse({
        roots: [],
        thumbnails: 0,
        queueDepth: 0,
        errorsSample: [],
        indexClear: progress,
        thumbnailClear: progress,
      }),
    ).toMatchObject({ indexClear: progress, thumbnailClear: progress });
  });
});

it("bounds internal directory metadata and rejects malformed or extra fields", async () => {
  const { IndexerDirectoryResponse } = await import("./index.ts");
  const entry = { name: "文 space%20", kind: "file" };
  expect(IndexerDirectoryResponse.parse({ items: [entry], overflow: false })).toEqual({
    items: [entry],
    overflow: false,
  });
  expect(
    IndexerDirectoryResponse.safeParse({
      items: Array.from({ length: 10000 }, () => entry),
      overflow: true,
    }).success,
  ).toBe(true);
  for (const value of [
    { items: Array.from({ length: 10001 }, () => entry), overflow: true },
    { items: [], overflow: false, extra: true },
    { items: [] },
    ...["", "x".repeat(256), "/root", "a\0b"].map((name) => ({
      items: [{ name, kind: "file" }],
      overflow: false,
    })),
    { items: [{ name: "a", kind: "unknown" }], overflow: false },
    { items: [{ ...entry, size: 1 }], overflow: false },
  ])
    expect(IndexerDirectoryResponse.safeParse(value).success).toBe(false);
  for (const kind of ["file", "dir", "symlink", "other"])
    expect(
      IndexerDirectoryResponse.safeParse({ items: [{ name: "a", kind }], overflow: false }).success,
    ).toBe(true);
});
