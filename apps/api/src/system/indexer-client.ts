import type {
  IndexerErrorSample,
  IndexerHealth,
  IndexerRootStats,
  IndexerStats,
  IndexerThumbnailRebuildJob,
  IndexerThumbnailsRebuildResponse,
} from "@fdrive/contracts";
import { IndexerClearResponse, IndexerDirectoryResponse } from "@fdrive/contracts";
import { z } from "zod";
import { callSidecar, type SidecarRequestDeps, type SidecarResult } from "./sidecar-client.js";

/**
 * Raw shapes returned by the indexer's own internal HTTP API
 * (`services/indexer/src/fdrive_indexer/server.py`, `stats.py`), snake_case
 * as Python emits it. `z.object` tolerates extra fields by default, so a
 * newer indexer adding fields never breaks this client.
 */
const IndexerHealthRaw = z.object({
  ok: z.boolean(),
  roots: z.array(z.string()),
  watcher: z.record(z.string(), z.boolean()),
  embed_ok: z.boolean(),
  schema_version: z.number().int().nullable(),
});

const IndexerLastScanRaw = z.object({
  started_at: z.string(),
  finished_at: z.string().nullable(),
  files_seen: z.number().int(),
  files_changed: z.number().int(),
  files_deleted: z.number().int(),
  errors: z.number().int(),
});

const IndexerRootStatsRaw = z.object({
  root: z.string(),
  counts_by_status: z.record(z.string(), z.number().int()),
  chunks: z.number().int(),
  chunks_embedded: z.number().int(),
  last_scan: IndexerLastScanRaw.nullable(),
});

const IndexerErrorSampleRaw = z.object({
  path: z.string(),
  error: z.string().nullable(),
});

/**
 * `.optional()` on every field (not just the object) so an older indexer
 * that has not yet added `thumbnail_rebuild` to `/stats`, or one that omits
 * a field this client does not know about yet, still parses; `toIndexerStats`
 * below only includes `thumbnailRebuild` when the raw object was present.
 */
const IndexerThumbnailRebuildRaw = z.object({
  running: z.boolean(),
  processed: z.number().int(),
  total: z.number().int(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  errors: z.number().int(),
});

const IndexerStatsRaw = z.object({
  roots: z.array(IndexerRootStatsRaw),
  thumbnails: z.number().int(),
  queue_depth: z.number().int(),
  errors_sample: z.array(IndexerErrorSampleRaw),
  thumbnail_rebuild: IndexerThumbnailRebuildRaw.optional(),
  index_clear: IndexerThumbnailRebuildRaw.optional(),
  thumbnail_clear: IndexerThumbnailRebuildRaw.optional(),
});

const IndexerCountRaw = z.object({ count: z.number().int() });

const IndexerThumbnailsRebuildRaw = z.object({
  started: z.boolean(),
  total: z.number().int(),
});

function toIndexerHealth(raw: z.infer<typeof IndexerHealthRaw>): IndexerHealth {
  return {
    ok: raw.ok,
    roots: raw.roots,
    watcher: raw.watcher,
    embedOk: raw.embed_ok,
    schemaVersion: raw.schema_version,
  };
}

function toIndexerRootStats(raw: z.infer<typeof IndexerRootStatsRaw>): IndexerRootStats {
  return {
    root: raw.root,
    countsByStatus: raw.counts_by_status,
    chunks: raw.chunks,
    chunksEmbedded: raw.chunks_embedded,
    lastScan:
      raw.last_scan === null
        ? null
        : {
            startedAt: raw.last_scan.started_at,
            finishedAt: raw.last_scan.finished_at,
            filesSeen: raw.last_scan.files_seen,
            filesChanged: raw.last_scan.files_changed,
            filesDeleted: raw.last_scan.files_deleted,
            errors: raw.last_scan.errors,
          },
  };
}

function toIndexerErrorSample(raw: z.infer<typeof IndexerErrorSampleRaw>): IndexerErrorSample {
  return { path: raw.path, error: raw.error };
}

function toIndexerThumbnailRebuildJob(
  raw: z.infer<typeof IndexerThumbnailRebuildRaw>,
): IndexerThumbnailRebuildJob {
  return {
    running: raw.running,
    processed: raw.processed,
    total: raw.total,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    errors: raw.errors,
  };
}

function toIndexerStats(raw: z.infer<typeof IndexerStatsRaw>): IndexerStats {
  return {
    roots: raw.roots.map(toIndexerRootStats),
    thumbnails: raw.thumbnails,
    queueDepth: raw.queue_depth,
    errorsSample: raw.errors_sample.map(toIndexerErrorSample),
    ...(raw.index_clear !== undefined
      ? { indexClear: toIndexerThumbnailRebuildJob(raw.index_clear) }
      : {}),
    ...(raw.thumbnail_clear !== undefined
      ? { thumbnailClear: toIndexerThumbnailRebuildJob(raw.thumbnail_clear) }
      : {}),
    ...(raw.thumbnail_rebuild !== undefined
      ? { thumbnailRebuild: toIndexerThumbnailRebuildJob(raw.thumbnail_rebuild) }
      : {}),
  };
}

export interface IndexerClientDeps extends SidecarRequestDeps {
  readonly baseUrl: string;
}

/**
 * Options for `IndexerClient.thumbnailsRebuild`. See `docs/INDEXER.md`. Every
 * field explicitly allows `undefined` (rather than only being absent) so a
 * `IndexerThumbnailsRebuildRequest` parsed by zod, whose `.optional()` fields
 * are typed the same way, can be passed straight through under
 * `exactOptionalPropertyTypes`.
 */
export interface ThumbnailsRebuildOptions {
  /** Omitted rebuilds every configured root. */
  readonly root?: string | undefined;
  /** Omitted rebuilds the whole root; otherwise a single file or directory subtree. */
  readonly path?: string | undefined;
  /** Delete and rewrite thumbnails that already exist, instead of only filling in missing ones. */
  readonly force?: boolean | undefined;
}

/** A typed client for the indexer's internal HTTP API. See `docs/INDEXER.md`. */
export interface IndexerClient {
  directory(root: string, path: string): Promise<SidecarResult<IndexerDirectoryResponse>>;
  clearIndex(options?: {
    root?: string | undefined;
    path?: string | undefined;
  }): Promise<SidecarResult<IndexerClearResponse>>;
  clearThumbnails(): Promise<SidecarResult<IndexerClearResponse>>;
  health(): Promise<SidecarResult<IndexerHealth>>;
  stats(): Promise<SidecarResult<IndexerStats>>;
  /** `thumbnails: true` also queues a best-effort thumbnail rebuild over the same scope. */
  reindex(
    root: string,
    path?: string,
    thumbnails?: boolean,
  ): Promise<SidecarResult<{ marked: number }>>;
  thumbnailsRebuild(
    options?: ThumbnailsRebuildOptions,
  ): Promise<SidecarResult<IndexerThumbnailsRebuildResponse>>;
}

/** Builds an `IndexerClient` calling `deps.baseUrl` with `deps.fetch`. */
export function createIndexerClient(deps: IndexerClientDeps): IndexerClient {
  return {
    async directory(root, path) {
      const query = new URLSearchParams({ root, path });
      return callSidecar(deps.baseUrl, `/directory?${query}`, IndexerDirectoryResponse, {}, deps);
    },
    async clearIndex(options) {
      return callSidecar(
        deps.baseUrl,
        "/index/clear",
        IndexerClearResponse,
        { method: "POST", jsonBody: options ?? {} },
        deps,
      );
    },

    async clearThumbnails() {
      return callSidecar(
        deps.baseUrl,
        "/thumbnails/clear",
        IndexerClearResponse,
        { method: "POST", jsonBody: {} },
        deps,
      );
    },

    async health() {
      const result = await callSidecar(deps.baseUrl, "/health", IndexerHealthRaw, {}, deps);
      return result.ok ? { ok: true, data: toIndexerHealth(result.data) } : result;
    },

    async stats() {
      const result = await callSidecar(deps.baseUrl, "/stats", IndexerStatsRaw, {}, deps);
      return result.ok ? { ok: true, data: toIndexerStats(result.data) } : result;
    },

    async reindex(root, path, thumbnails) {
      const result = await callSidecar(
        deps.baseUrl,
        "/reindex",
        IndexerCountRaw,
        {
          method: "POST",
          jsonBody: {
            root,
            ...(path !== undefined ? { path } : {}),
            ...(thumbnails !== undefined ? { thumbnails } : {}),
          },
        },
        deps,
      );
      return result.ok ? { ok: true, data: { marked: result.data.count } } : result;
    },

    async thumbnailsRebuild(options) {
      const result = await callSidecar(
        deps.baseUrl,
        "/thumbnails/rebuild",
        IndexerThumbnailsRebuildRaw,
        {
          method: "POST",
          jsonBody: {
            ...(options?.root !== undefined ? { root: options.root } : {}),
            ...(options?.path !== undefined ? { path: options.path } : {}),
            ...(options?.force !== undefined ? { force: options.force } : {}),
          },
        },
        deps,
      );
      return result;
    },
  };
}
