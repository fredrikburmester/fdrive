import type {
  OcrHealth,
  OcrLastRun,
  OcrOriginal,
  OcrOriginalDeleteResponse,
  OcrOriginalRestoreRequest,
  OcrOriginalRestoreResponse,
  OcrOriginalState,
  OcrOriginalsResponse,
  OcrStats,
} from "@fdrive/contracts";
import { z } from "zod";
import {
  callSidecar,
  joinSidecarUrl,
  type SidecarRequestDeps,
  type SidecarResult,
} from "./sidecar-client.js";

/**
 * Raw shapes returned by the OCR service's internal HTTP API (see docs/OCR.md
 * and `services/ocr/src/fdrive_ocr/server.py`). `z.object` tolerates extra
 * fields by default, so the service can add to a response without breaking
 * an API that has not been redeployed yet.
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
  originals_retention_days: z.number().int(),
  originals_count: z.number().int(),
  originals_bytes: z.number().int(),
  running: z.boolean(),
});

const OcrRunRaw = z.object({ started: z.boolean() });

const OcrOriginalState_ = z.enum(["ocred", "restored", "changed", "missing"]);

const OcrOriginalRaw = z.object({
  id: z.string(),
  root: z.string().nullable(),
  path: z.string().nullable(),
  size: z.number().int(),
  /** Epoch seconds; the service works in float time, the contract in ISO-8601. */
  kept_at: z.number(),
  sha256: z.string().nullable(),
  legacy: z.boolean(),
  state: OcrOriginalState_.nullable(),
});

const OcrOriginalsRaw = z.object({
  items: z.array(OcrOriginalRaw),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
});

const OcrRestoreRaw = z.object({
  restored: z.boolean(),
  root: z.string().nullable(),
  path: z.string().nullable(),
  previous_state: OcrOriginalState_.nullable(),
});

const OcrDeleteRaw = z.object({ deleted: z.boolean() });

/** The body the service sends with a refusal, so the operator sees the reason. */
const OcrRefusalRaw = z.object({
  error: z.string(),
  state: OcrOriginalState_.nullish(),
  root: z.string().nullish(),
  path: z.string().nullish(),
});

/** A refusal the OCR service explained, as opposed to a sidecar that is simply down. */
export interface OcrRefusal {
  readonly reason: string;
  readonly state: OcrOriginalState | null;
  readonly root: string | null;
  readonly path: string | null;
  readonly status: number;
}

/**
 * Reads the refusal a non-2xx sidecar response carried, or `null` when the
 * failure was not a refusal (the service was unreachable, or answered with
 * something that is not a refusal body).
 */
export function ocrRefusal(result: SidecarResult<unknown>): OcrRefusal | null {
  if (result.ok || result.status === undefined) {
    return null;
  }
  const parsed = OcrRefusalRaw.safeParse(result.body);
  if (!parsed.success) {
    return null;
  }
  return {
    reason: parsed.data.error,
    state: parsed.data.state ?? null,
    root: parsed.data.root ?? null,
    path: parsed.data.path ?? null,
    status: result.status,
  };
}

function toOcrOriginal(raw: z.infer<typeof OcrOriginalRaw>): OcrOriginal {
  return {
    id: raw.id,
    root: raw.root,
    path: raw.path,
    size: raw.size,
    keptAt: new Date(raw.kept_at * 1000).toISOString(),
    sha256: raw.sha256,
    legacy: raw.legacy,
    state: raw.state,
  };
}

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
    originalsRetentionDays: raw.originals_retention_days,
    originalsCount: raw.originals_count,
    originalsBytes: raw.originals_bytes,
    running: raw.running,
  };
}

export interface OcrClientDeps extends SidecarRequestDeps {
  readonly baseUrl: string;
}

/** How long a restore may take. It copies file bytes, unlike every other call here. */
export const OCR_RESTORE_TIMEOUT_MS = 120_000;

/** How long a download may take to *start*; the body then streams unbounded. */
export const OCR_DOWNLOAD_TIMEOUT_MS = 30_000;

export type OcrDownloadResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly detail: string; readonly status?: number };

export interface OcrOriginalsQuery {
  readonly query?: string | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

/** A typed client for the OCR service's internal HTTP API. */
export interface OcrClient {
  health(): Promise<SidecarResult<OcrHealth>>;
  stats(): Promise<SidecarResult<OcrStats>>;
  run(): Promise<SidecarResult<{ started: boolean }>>;
  originals(query: OcrOriginalsQuery): Promise<SidecarResult<OcrOriginalsResponse>>;
  restoreOriginal(
    req: OcrOriginalRestoreRequest,
  ): Promise<SidecarResult<OcrOriginalRestoreResponse>>;
  deleteOriginal(id: string): Promise<SidecarResult<OcrOriginalDeleteResponse>>;
  /** The raw upstream response, so the route can stream the bytes straight through. */
  downloadOriginal(id: string): Promise<OcrDownloadResult>;
}

function originalsPath(query: OcrOriginalsQuery): string {
  const params = new URLSearchParams();
  if (query.query !== undefined && query.query !== "") {
    params.set("query", query.query);
  }
  if (query.offset !== undefined) {
    params.set("offset", String(query.offset));
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const qs = params.toString();
  return qs === "" ? "/originals" : `/originals?${qs}`;
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

    async originals(query) {
      const result = await callSidecar(
        deps.baseUrl,
        originalsPath(query),
        OcrOriginalsRaw,
        {},
        deps,
      );
      return result.ok
        ? {
            ok: true,
            data: {
              items: result.data.items.map(toOcrOriginal),
              total: result.data.total,
              offset: result.data.offset,
              limit: result.data.limit,
            },
          }
        : result;
    },

    async restoreOriginal(req) {
      const result = await callSidecar(
        deps.baseUrl,
        "/originals/restore",
        OcrRestoreRaw,
        {
          method: "POST",
          jsonBody: {
            id: req.id,
            allow_recreate: req.allowRecreate === true,
            allow_overwrite_changed: req.allowOverwriteChanged === true,
          },
          timeoutMs: OCR_RESTORE_TIMEOUT_MS,
        },
        deps,
      );
      return result.ok
        ? {
            ok: true,
            data: {
              restored: result.data.restored,
              root: result.data.root,
              path: result.data.path,
              previousState: result.data.previous_state,
            },
          }
        : result;
    },

    async deleteOriginal(id) {
      return callSidecar(
        deps.baseUrl,
        "/originals/delete",
        OcrDeleteRaw,
        { method: "POST", jsonBody: { id } },
        deps,
      );
    },

    async downloadOriginal(id) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OCR_DOWNLOAD_TIMEOUT_MS);
      try {
        const url = joinSidecarUrl(
          deps.baseUrl,
          `/originals/download?id=${encodeURIComponent(id)}`,
        );
        const response = await deps.fetch(url, { signal: controller.signal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, detail: `status ${response.status}`, status: response.status };
        }
        return { ok: true, response };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : "network error" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
