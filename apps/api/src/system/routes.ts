import {
  type IndexerActionResponse,
  IndexerClearRequest,
  IndexerReindexRequest,
  type IndexerSettingsResponse,
  IndexerSettingsUpdateRequest,
  IndexerThumbnailsRebuildRequest,
  type IndexerThumbnailsRebuildResponse,
  type OcrRunResponse,
  type OcrSettingsResponse,
  OcrSettingsUpdateRequest,
  ROUTES,
  type SystemImageSearchResponse,
  type SystemIndexerResponse,
  type SystemLogEntry,
  SystemLogSubsystem,
  SystemLogsQuery,
  type SystemLogsResponse,
  type SystemOcrResponse,
  type SystemReembedResponse,
  type SystemSearchResponse,
  type SystemThumbnailsResponse,
} from "@fdrive/contracts";
import type { IndexQueries, SettingsRepo, SystemEventRepo } from "@fdrive/db";
import { z } from "zod";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { ImageEmbedClient } from "../search/image-embed-client.js";
import { fetchEmbedStatus } from "./embed-status.js";
import type { SystemEventLog } from "./event-log.js";
import type { IndexerClient } from "./indexer-client.js";
import type { OcrClient } from "./ocr-client.js";
import {
  indexerSettingsEntries,
  ocrSettingsEntries,
  resolveIndexerSettings,
  resolveOcrSettings,
} from "./settings.js";
import type { ThumbnailsRepo } from "./thumbnails-repo.js";
import { walkThumbnailBytes as defaultWalkThumbnailBytes } from "./thumbnails-walk.js";

/**
 * How many files `GET /system/thumbnails` will `stat()` while summing the
 * thumbnail cache's size on disk. The indexer's cache can hold hundreds of
 * thousands of small WebP files; this keeps a page load bounded rather than
 * an unbounded walk.
 */
export const THUMBNAILS_WALK_MAX_FILES = 200_000;

/** Text statuses (`docs/INDEXER.md`) that mean a file actually has extracted text. */
const TEXT_STATUSES_WITH_TEXT = new Set(["indexed", "partial"]);

export interface SystemRoutesDeps {
  readonly settings: SettingsRepo;
  /** Backs `GET /system/:subsystem/logs`; reads merge the API's rows with sidecar history. */
  readonly systemEvents: SystemEventRepo;
  /** Records what an admin did here, for the same log. Never awaited by a handler. */
  readonly eventLog: SystemEventLog;
  readonly indexQueries: IndexQueries;
  readonly thumbnailsRepo: ThumbnailsRepo;
  /** `null` when `FDRIVE_INDEXER_URL` is not configured. */
  readonly indexerClient: IndexerClient | null;
  /** `null` when `FDRIVE_OCR_URL` is not configured. */
  readonly ocrClient: OcrClient | null;
  /** The TEI base URL (`FDRIVE_EMBED_URL`), `undefined` when semantic search is not configured. */
  readonly embedUrl: string | undefined;
  /** `null` when `FDRIVE_IMAGE_EMBED_URL` is not configured. */
  readonly imageEmbedClient: ImageEmbedClient | null;
  /** `FDRIVE_THUMBS_DIR`, `undefined` when thumbnails are not configured. */
  readonly thumbsDir: string | undefined;
  /** Every configured index root's name (`FDRIVE_INDEX_ROOTS`). */
  readonly indexRootNames: readonly string[];
  readonly fetch: typeof globalThis.fetch;
  /** Overridable for tests; defaults to the real filesystem walk. */
  readonly walkThumbnailBytes?: typeof defaultWalkThumbnailBytes;
}

function sidecarErrorMessage(service: string, result: { reason: string; detail: string }): string {
  return `${service} is ${result.reason === "unreachable" ? "unreachable" : "returning an unexpected response"}: ${result.detail}`;
}

/**
 * Throws for a failed `thumbnailsRebuild` call: a `409` (a rebuild is already
 * running, process-wide, per `docs/INDEXER.md`) becomes a `conflict` rather
 * than the generic `upstream_unavailable` every other sidecar failure maps
 * to, so the web app can show "already running" instead of "unreachable".
 */
function throwForThumbnailsRebuildFailure(result: {
  reason: string;
  detail: string;
  status?: number;
}): never {
  if (result.status === 409) {
    throw new ApiHttpError("conflict", "a thumbnail rebuild is already running");
  }
  throw new ApiHttpError("upstream_unavailable", sidecarErrorMessage("the indexer", result));
}

function throwForClearFailure(result: { reason: string; detail: string; status?: number }): never {
  if (result.status === 400) {
    throw new ApiHttpError("bad_request", "invalid clear request");
  }
  if (result.status === 404) {
    throw new ApiHttpError("not_found", "unknown index root");
  }
  if (result.status === 409) {
    throw new ApiHttpError("conflict", "a clear or thumbnail rebuild is already running");
  }
  throw new ApiHttpError("upstream_unavailable", sidecarErrorMessage("the indexer", result));
}

/**
 * The keys whose value `after` changes relative to `before`, recorded with
 * a settings-update event so the log says what an admin actually touched
 * rather than just that they pressed Save.
 */
export function changedSettingKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

/** Empty bodies are allowed; malformed JSON must never become a global clear. */
function parseClearBody(text: string): unknown {
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiHttpError("bad_request", "invalid clear request JSON");
  }
}

/**
 * Registers every `/system/*` route (indexer, search, OCR, thumbnails), all
 * behind `createRequireAdmin()`. A sidecar that is not configured 400s on
 * mutating actions; one that is configured but unreachable responds
 * `upstream_unavailable` (502) on mutating actions, while the `GET`
 * summaries always return 200 with `reachable: false` so a down sidecar
 * renders as a status badge rather than an error page.
 */
export function registerSystemRoutes(groups: { authed: AuthedHono }, deps: SystemRoutesDeps): void {
  const authed: AuthedHono = groups.authed;
  const requireAdmin = createRequireAdmin();
  const walkThumbnailBytes = deps.walkThumbnailBytes ?? defaultWalkThumbnailBytes;

  authed.get(withoutApiV1Prefix(ROUTES.system.indexer), requireAdmin, async (c) => {
    const settingsAll = await deps.settings.all();
    const settings = resolveIndexerSettings(settingsAll);

    if (deps.indexerClient === null) {
      const body: SystemIndexerResponse = { configured: false, reachable: false, settings };
      return c.json(body);
    }

    const [healthResult, statsResult] = await Promise.all([
      deps.indexerClient.health(),
      deps.indexerClient.stats(),
    ]);

    const body: SystemIndexerResponse = {
      configured: true,
      reachable: healthResult.ok || statsResult.ok,
      ...(healthResult.ok ? { health: healthResult.data } : {}),
      ...(statsResult.ok ? { stats: statsResult.data } : {}),
      settings,
    };
    return c.json(body);
  });

  authed.put(withoutApiV1Prefix(ROUTES.system.indexerSettings), requireAdmin, async (c) => {
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    const parsed = IndexerSettingsUpdateRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid indexer settings", {
        issues: parsed.error.issues,
      });
    }

    const before = resolveIndexerSettings(await deps.settings.all()).values;
    for (const [key, value] of indexerSettingsEntries(parsed.data)) {
      await deps.settings.set(key, value);
    }

    const settingsAll = await deps.settings.all();
    const body: IndexerSettingsResponse = resolveIndexerSettings(settingsAll);
    deps.eventLog.record("indexer", "info", "Settings updated", {
      changed: changedSettingKeys(before, parsed.data),
    });
    return c.json(body);
  });

  authed.post(withoutApiV1Prefix(ROUTES.system.indexerReindex), requireAdmin, async (c) => {
    if (deps.indexerClient === null) {
      throw new ApiHttpError("bad_request", "the indexer is not configured");
    }

    const rawBody: unknown = await c.req.json().catch(() => undefined);
    const parsed = IndexerReindexRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid reindex request", {
        issues: parsed.error.issues,
      });
    }

    const target = {
      ...(parsed.data.root === undefined ? {} : { root: parsed.data.root }),
      ...(parsed.data.path === undefined ? {} : { path: parsed.data.path }),
      ...(parsed.data.thumbnails === undefined ? {} : { thumbnails: parsed.data.thumbnails }),
    };
    const result = await deps.indexerClient.reindex(
      parsed.data.root,
      parsed.data.path,
      parsed.data.thumbnails,
    );
    if (!result.ok) {
      deps.eventLog.record("indexer", "error", `Reindex failed: ${result.detail}`, target);
      throw new ApiHttpError("upstream_unavailable", sidecarErrorMessage("the indexer", result));
    }
    deps.eventLog.record("indexer", "info", "Reindex requested", target);

    const body: IndexerActionResponse = result.data;
    return c.json(body);
  });

  authed.post(
    withoutApiV1Prefix(ROUTES.system.indexerThumbnailsRebuild),
    requireAdmin,
    async (c) => {
      if (deps.indexerClient === null) {
        throw new ApiHttpError("bad_request", "the indexer is not configured");
      }

      const rawBody: unknown = await c.req.json().catch(() => ({}));
      const parsed = IndexerThumbnailsRebuildRequest.safeParse(rawBody);
      if (!parsed.success) {
        throw new ApiHttpError("bad_request", "invalid request", {
          issues: parsed.error.issues,
        });
      }

      const result = await deps.indexerClient.thumbnailsRebuild(parsed.data);
      if (!result.ok) {
        deps.eventLog.record(
          "thumbnails",
          "error",
          `Thumbnail rebuild failed: ${result.detail}`,
          parsed.data,
        );
        throwForThumbnailsRebuildFailure(result);
      }
      deps.eventLog.record("thumbnails", "info", "Thumbnail rebuild requested", parsed.data);

      const body: IndexerThumbnailsRebuildResponse = result.data;
      return c.json(body, 202);
    },
  );

  authed.post(withoutApiV1Prefix(ROUTES.system.indexerClear), requireAdmin, async (c) => {
    if (deps.indexerClient === null) {
      throw new ApiHttpError("bad_request", "the indexer is not configured");
    }
    const parsed = IndexerClearRequest.safeParse(parseClearBody(await c.req.text()));
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid clear request", {
        issues: parsed.error.issues,
      });
    }
    const result = await deps.indexerClient.clearIndex(parsed.data);
    if (!result.ok) {
      deps.eventLog.record("indexer", "error", `Index clear failed: ${result.detail}`, parsed.data);
      throwForClearFailure(result);
    }
    deps.eventLog.record("indexer", "warn", "Index clear requested", parsed.data);
    return c.json(result.data, 202);
  });

  authed.post(withoutApiV1Prefix(ROUTES.system.thumbnailsClear), requireAdmin, async (c) => {
    if (deps.indexerClient === null) {
      throw new ApiHttpError("bad_request", "the indexer is not configured");
    }
    const parsed = z.strictObject({}).safeParse(parseClearBody(await c.req.text()));
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid clear request", {
        issues: parsed.error.issues,
      });
    }
    const result = await deps.indexerClient.clearThumbnails();
    if (!result.ok) {
      deps.eventLog.record("thumbnails", "error", `Thumbnail clear failed: ${result.detail}`);
      throwForClearFailure(result);
    }
    deps.eventLog.record("thumbnails", "warn", "Thumbnail clear requested");
    return c.json(result.data, 202);
  });

  authed.get(withoutApiV1Prefix(ROUTES.system.search), requireAdmin, async (c) => {
    const configured = deps.indexRootNames.length > 0;
    const semantic = await fetchEmbedStatus({ baseUrl: deps.embedUrl, fetch: deps.fetch });

    const rootIds = await deps.indexQueries.rootIdsByName();
    const prefixes = deps.indexRootNames
      .map((name) => rootIds[name])
      .filter((rootId): rootId is number => rootId !== undefined)
      .map((rootId) => ({ rootId, fsPrefix: "/" }));

    const stats = await deps.indexQueries.stats(prefixes);
    const withText = stats.byTextStatus
      .filter((row) => TEXT_STATUSES_WITH_TEXT.has(row.status))
      .reduce((sum, row) => sum + row.files, 0);

    const body: SystemSearchResponse = {
      configured,
      semantic,
      roots: [...deps.indexRootNames],
      index: {
        files: stats.filesTracked,
        withText,
        chunks: stats.chunks,
        embedded: stats.chunksEmbedded,
      },
    };
    return c.json(body);
  });

  authed.post(withoutApiV1Prefix(ROUTES.system.searchReembed), requireAdmin, async (c) => {
    if (deps.indexerClient === null) {
      throw new ApiHttpError("bad_request", "the indexer is not configured");
    }
    if (deps.indexRootNames.length === 0) {
      throw new ApiHttpError("bad_request", "no index roots are configured");
    }

    const indexerClient = deps.indexerClient;
    let marked = 0;
    for (const root of deps.indexRootNames) {
      const result = await indexerClient.reindex(root);
      if (!result.ok) {
        deps.eventLog.record("search", "error", `Reembed failed: ${result.detail}`, { root });
        throw new ApiHttpError(
          "upstream_unavailable",
          sidecarErrorMessage(`the indexer (root "${root}")`, result),
        );
      }
      marked += result.data.marked;
    }
    deps.eventLog.record("search", "info", "Reembed requested", {
      roots: [...deps.indexRootNames],
    });

    const body: SystemReembedResponse = { marked, roots: [...deps.indexRootNames] };
    return c.json(body);
  });

  authed.get(withoutApiV1Prefix(ROUTES.system.imageSearch), requireAdmin, async (c) => {
    const [healthResult, embeddingStats, statsResult] = await Promise.all([
      deps.imageEmbedClient === null ? Promise.resolve(null) : deps.imageEmbedClient.health(),
      deps.indexQueries.imageEmbeddingStats(),
      deps.indexerClient === null ? Promise.resolve(null) : deps.indexerClient.stats(),
    ]);

    const stats = statsResult?.ok === true ? statsResult.data : undefined;

    const body: SystemImageSearchResponse = {
      configured: deps.imageEmbedClient !== null,
      healthy: healthResult?.ok === true && healthResult.data.status === "ok",
      ...(healthResult?.ok === true
        ? {
            model: healthResult.data.model,
            ...(healthResult.data.dim !== null ? { dim: healthResult.data.dim } : {}),
          }
        : {}),
      embedded: embeddingStats.total,
      embeddedModel: embeddingStats.model,
      ...(stats?.imageEmbeddingRebuild !== undefined
        ? { rebuild: stats.imageEmbeddingRebuild }
        : {}),
      ...(stats?.imageEmbeddingClear !== undefined ? { clear: stats.imageEmbeddingClear } : {}),
    };
    return c.json(body);
  });

  authed.post(withoutApiV1Prefix(ROUTES.system.imageSearchRebuild), requireAdmin, async (c) => {
    if (deps.indexerClient === null) {
      throw new ApiHttpError("bad_request", "the indexer is not configured");
    }

    const rawBody: unknown = await c.req.json().catch(() => ({}));
    const parsed = IndexerThumbnailsRebuildRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid request", { issues: parsed.error.issues });
    }

    const result = await deps.indexerClient.imageEmbeddingsRebuild(parsed.data);
    if (!result.ok) {
      deps.eventLog.record(
        "image-search",
        "error",
        `Image embedding rebuild failed: ${result.detail}`,
        parsed.data,
      );
      throwForThumbnailsRebuildFailure(result);
    }
    deps.eventLog.record("image-search", "info", "Image embedding rebuild requested", parsed.data);

    const body: IndexerThumbnailsRebuildResponse = result.data;
    return c.json(body, 202);
  });

  authed.post(withoutApiV1Prefix(ROUTES.system.imageSearchClear), requireAdmin, async (c) => {
    if (deps.indexerClient === null) {
      throw new ApiHttpError("bad_request", "the indexer is not configured");
    }
    const parsed = z.strictObject({}).safeParse(parseClearBody(await c.req.text()));
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid clear request", {
        issues: parsed.error.issues,
      });
    }
    const result = await deps.indexerClient.clearImageEmbeddings();
    if (!result.ok) {
      deps.eventLog.record(
        "image-search",
        "error",
        `Image embedding clear failed: ${result.detail}`,
      );
      throwForClearFailure(result);
    }
    deps.eventLog.record("image-search", "warn", "Image embedding clear requested");
    return c.json(result.data, 202);
  });

  authed.get(withoutApiV1Prefix(ROUTES.system.ocr), requireAdmin, async (c) => {
    const settingsAll = await deps.settings.all();
    const settings = resolveOcrSettings(settingsAll);

    if (deps.ocrClient === null) {
      const body: SystemOcrResponse = { configured: false, reachable: false, settings };
      return c.json(body);
    }

    const [healthResult, statsResult] = await Promise.all([
      deps.ocrClient.health(),
      deps.ocrClient.stats(),
    ]);

    const body: SystemOcrResponse = {
      configured: true,
      reachable: healthResult.ok || statsResult.ok,
      ...(healthResult.ok ? { health: healthResult.data } : {}),
      ...(statsResult.ok ? { stats: statsResult.data } : {}),
      settings,
    };
    return c.json(body);
  });

  authed.put(withoutApiV1Prefix(ROUTES.system.ocrSettings), requireAdmin, async (c) => {
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    const parsed = OcrSettingsUpdateRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid OCR settings", {
        issues: parsed.error.issues,
      });
    }

    const before = resolveOcrSettings(await deps.settings.all()).values;
    for (const [key, value] of ocrSettingsEntries(parsed.data)) {
      await deps.settings.set(key, value);
    }

    const settingsAll = await deps.settings.all();
    const body: OcrSettingsResponse = resolveOcrSettings(settingsAll);
    deps.eventLog.record("ocr", "info", "Settings updated", {
      changed: changedSettingKeys(before, parsed.data),
    });
    return c.json(body);
  });

  authed.post(withoutApiV1Prefix(ROUTES.system.ocrRun), requireAdmin, async (c) => {
    if (deps.ocrClient === null) {
      throw new ApiHttpError("bad_request", "OCR is not configured");
    }

    const result = await deps.ocrClient.run();
    if (!result.ok) {
      deps.eventLog.record("ocr", "error", `OCR run failed: ${result.detail}`);
      throw new ApiHttpError("upstream_unavailable", sidecarErrorMessage("OCR", result));
    }
    deps.eventLog.record("ocr", "info", "OCR run requested");

    const body: OcrRunResponse = result.data;
    return c.json(body);
  });

  authed.get(withoutApiV1Prefix(ROUTES.system.thumbnails), requireAdmin, async (c) => {
    const configured = deps.thumbsDir !== undefined;
    const count = await deps.thumbnailsRepo.count();
    const bytes =
      deps.thumbsDir === undefined
        ? 0
        : (await walkThumbnailBytes(deps.thumbsDir, THUMBNAILS_WALK_MAX_FILES)).bytes;

    const body: SystemThumbnailsResponse = { configured, count, bytes };
    return c.json(body);
  });

  authed.post(withoutApiV1Prefix(ROUTES.system.thumbnailsRebuild), requireAdmin, async (c) => {
    if (deps.indexerClient === null) {
      throw new ApiHttpError("bad_request", "the indexer is not configured");
    }

    const result = await deps.indexerClient.thumbnailsRebuild();
    if (!result.ok) {
      deps.eventLog.record("thumbnails", "error", `Thumbnail rebuild failed: ${result.detail}`);
      throwForThumbnailsRebuildFailure(result);
    }
    deps.eventLog.record("thumbnails", "info", "Thumbnail rebuild requested");

    const body: IndexerThumbnailsRebuildResponse = result.data;
    return c.json(body, 202);
  });

  // Registered last, and with a literal `/logs` suffix, so it can never
  // shadow the fixed `/system/<name>` routes above.
  authed.get("/system/:subsystem/logs", requireAdmin, async (c) => {
    const subsystem = SystemLogSubsystem.safeParse(c.req.param("subsystem"));
    if (!subsystem.success) {
      throw new ApiHttpError("bad_request", "unknown subsystem", {
        issues: subsystem.error.issues,
      });
    }
    const query = SystemLogsQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new ApiHttpError("bad_request", "invalid log query", { issues: query.error.issues });
    }

    const { limit, level, before } = query.data;
    const events = await deps.systemEvents.list(subsystem.data, {
      limit,
      minLevel: level,
      ...(before === undefined ? {} : { before: new Date(before) }),
    });
    const entries: SystemLogEntry[] = events.map((event) => ({
      id: event.id,
      at: event.at.toISOString(),
      level: event.level,
      message: event.message,
      ...(event.data === null ? {} : { data: event.data }),
      source: event.source,
    }));

    // A full page means there may be more; a short one is the end of the
    // log, so no cursor is offered and the caller stops paging.
    const last = entries.length === limit ? entries[entries.length - 1] : undefined;
    const body: SystemLogsResponse = {
      subsystem: subsystem.data,
      entries,
      ...(last === undefined ? {} : { nextCursor: last.at }),
    };
    return c.json(body);
  });
}
