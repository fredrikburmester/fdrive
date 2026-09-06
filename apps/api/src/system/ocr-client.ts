import type { OcrHealth, OcrLastRun, OcrStats } from "@fdrive/contracts";
import { z } from "zod";
import { callSidecar, type SidecarRequestDeps, type SidecarResult } from "./sidecar-client.js";

/**
 * Raw shapes returned by the OCR service's internal HTTP API, as documented
 * in the chunk brief (the service itself is being built in a parallel
 * chunk). `z.object` tolerates extra fields by default.
 */
const OcrHealthRaw = z.object({
  ok: z.boolean(),
  running: z.boolean(),
});

const OcrLastRunRaw = z.object({
  started_at: z.string(),
  finished_at: z.string().nullable(),
  seen: z.number().int(),
  ocred: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
});

const OcrStatsRaw = z.object({
  last_run: OcrLastRunRaw.nullable(),
  next_run_at: z.string().nullable(),
  schedule_hour: z.number().int(),
  langs: z.string(),
  exclude_globs: z.array(z.string()),
  max_mb: z.number().int(),
  keep_originals: z.boolean(),
  originals_count: z.number().int(),
  originals_bytes: z.number().int(),
  running: z.boolean(),
});

const OcrRunRaw = z.object({ started: z.boolean() });

function toOcrHealth(raw: z.infer<typeof OcrHealthRaw>): OcrHealth {
  return { ok: raw.ok, running: raw.running };
}

function toOcrLastRun(raw: z.infer<typeof OcrLastRunRaw>): OcrLastRun {
  return {
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    seen: raw.seen,
    ocred: raw.ocred,
    skipped: raw.skipped,
    failed: raw.failed,
  };
}

function toOcrStats(raw: z.infer<typeof OcrStatsRaw>): OcrStats {
  return {
    lastRun: raw.last_run === null ? null : toOcrLastRun(raw.last_run),
    nextRunAt: raw.next_run_at,
    scheduleHour: raw.schedule_hour,
    langs: raw.langs,
    excludeGlobs: raw.exclude_globs,
    maxMb: raw.max_mb,
    keepOriginals: raw.keep_originals,
    originalsCount: raw.originals_count,
    originalsBytes: raw.originals_bytes,
    running: raw.running,
  };
}

export interface OcrClientDeps extends SidecarRequestDeps {
  readonly baseUrl: string;
}

/** A typed client for the OCR service's internal HTTP API. */
export interface OcrClient {
  health(): Promise<SidecarResult<OcrHealth>>;
  stats(): Promise<SidecarResult<OcrStats>>;
  run(): Promise<SidecarResult<{ started: boolean }>>;
}

/** Builds an `OcrClient` calling `deps.baseUrl` with `deps.fetch`. */
export function createOcrClient(deps: OcrClientDeps): OcrClient {
  return {
    async health() {
      const result = await callSidecar(deps.baseUrl, "/health", OcrHealthRaw, {}, deps);
      return result.ok ? { ok: true, data: toOcrHealth(result.data) } : result;
    },

    async stats() {
      const result = await callSidecar(deps.baseUrl, "/stats", OcrStatsRaw, {}, deps);
      return result.ok ? { ok: true, data: toOcrStats(result.data) } : result;
    },

    async run() {
      const result = await callSidecar(deps.baseUrl, "/run", OcrRunRaw, { method: "POST" }, deps);
      return result.ok ? { ok: true, data: { started: result.data.started } } : result;
    },
  };
}
