import type {
  IndexerErrorSample,
  IndexerHealth,
  IndexerRootStats,
  IndexerStats,
} from "@fdrive/contracts";
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

const IndexerStatsRaw = z.object({
  roots: z.array(IndexerRootStatsRaw),
  thumbnails: z.number().int(),
  queue_depth: z.number().int(),
  errors_sample: z.array(IndexerErrorSampleRaw),
});

const IndexerCountRaw = z.object({ count: z.number().int() });

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

function toIndexerStats(raw: z.infer<typeof IndexerStatsRaw>): IndexerStats {
  return {
    roots: raw.roots.map(toIndexerRootStats),
    thumbnails: raw.thumbnails,
    queueDepth: raw.queue_depth,
    errorsSample: raw.errors_sample.map(toIndexerErrorSample),
  };
}

export interface IndexerClientDeps extends SidecarRequestDeps {
  readonly baseUrl: string;
}

/** A typed client for the indexer's internal HTTP API. See `docs/INDEXER.md`. */
export interface IndexerClient {
  health(): Promise<SidecarResult<IndexerHealth>>;
  stats(): Promise<SidecarResult<IndexerStats>>;
  reindex(root: string, path?: string): Promise<SidecarResult<{ marked: number }>>;
  thumbnailsRebuild(root?: string): Promise<SidecarResult<{ marked: number }>>;
}

/** Builds an `IndexerClient` calling `deps.baseUrl` with `deps.fetch`. */
export function createIndexerClient(deps: IndexerClientDeps): IndexerClient {
  return {
    async health() {
      const result = await callSidecar(deps.baseUrl, "/health", IndexerHealthRaw, {}, deps);
      return result.ok ? { ok: true, data: toIndexerHealth(result.data) } : result;
    },

    async stats() {
      const result = await callSidecar(deps.baseUrl, "/stats", IndexerStatsRaw, {}, deps);
      return result.ok ? { ok: true, data: toIndexerStats(result.data) } : result;
    },

    async reindex(root, path) {
      const result = await callSidecar(
        deps.baseUrl,
        "/reindex",
        IndexerCountRaw,
        { method: "POST", jsonBody: path !== undefined ? { root, path } : { root } },
        deps,
      );
      return result.ok ? { ok: true, data: { marked: result.data.count } } : result;
    },

    async thumbnailsRebuild(root) {
      const result = await callSidecar(
        deps.baseUrl,
        "/thumbnails/rebuild",
        IndexerCountRaw,
        { method: "POST", jsonBody: root !== undefined ? { root } : {} },
        deps,
      );
      return result.ok ? { ok: true, data: { marked: result.data.count } } : result;
    },
  };
}
