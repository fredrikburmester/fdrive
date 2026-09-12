import {
  FEATURE_IDS,
  FEATURES_SETTINGS_KEY,
  FeatureConfiguration,
  type FeatureId,
  type FeatureStatus,
  type FeaturesUpdateRequest,
  type FeatureValues,
  type SystemFeaturesResponse,
  type SystemLogSubsystem,
} from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { createCachedProbe } from "../system/cached-probe.js";
import type { SystemEventLog } from "../system/event-log.js";
import { noopSystemEventLog } from "../system/event-log.js";
import { runtimeError } from "../system/runtime-status.js";

/**
 * Which subsystem's log a feature toggle belongs in. Several features are
 * carried by the indexer, so their entries land in the indexer's log
 * rather than in one log per toggle.
 */
export const FEATURE_LOG_SUBSYSTEMS: Record<FeatureId, SystemLogSubsystem> = {
  thumbnails: "indexer",
  textSearch: "indexer",
  searchOcr: "indexer",
  pdfOcr: "ocr",
  semanticSearch: "search",
  imageSearch: "image-search",
};

/** The worker each `status()` probe stands for, and the log its reachability is reported in. */
const PROBE_SUBSYSTEMS = {
  indexer: "indexer",
  ocr: "ocr",
  embed: "search",
  image: "image-search",
} as const satisfies Record<string, SystemLogSubsystem>;

type ProbeName = keyof typeof PROBE_SUBSYSTEMS;

export const DISABLED_FEATURES: FeatureValues = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};

export interface FeatureSettingsStore extends Pick<SettingsRepo, "get"> {
  compareAndSet(key: string, expected: unknown | null, value: unknown): Promise<boolean>;
}

export interface FeatureService {
  configuration(): Promise<FeatureConfiguration>;
  status(): Promise<SystemFeaturesResponse>;
  update(input: FeaturesUpdateRequest): Promise<FeatureConfiguration>;
  enabled(feature: FeatureId): Promise<boolean>;
}

interface Probe {
  ok: boolean;
  status?: string;
  /** A controller's own fixed reason when `status` is `failed`; see `runtime-status.ts`. */
  error?: string;
  revision?: number;
  detail?: string;
  values?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  running?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function probe(
  url: string | undefined,
  fetchImpl: typeof fetch,
  runtimePort?: string,
): Promise<Probe> {
  if (url === undefined)
    return { ok: false, detail: "Worker is not installed in this deployment." };
  try {
    const endpoint = new URL(url);
    if (runtimePort !== undefined) endpoint.port = runtimePort;
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${runtimePort === undefined ? "health" : "runtime"}`;
    const response = await fetchImpl(endpoint.toString(), {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok)
      return { ok: false, detail: "Worker is unavailable. Retry after checking its status." };
    const body = record(await response.json());
    const features = record(body.features);
    const error = runtimeError(body);
    return {
      ok: body.ok !== false,
      ...(error === null ? {} : { error }),
      ...(typeof features.status === "string"
        ? { status: features.status }
        : typeof body.status === "string"
          ? { status: body.status }
          : {}),
      values: record(features.values),
      ...(body.storage === undefined ? {} : { storage: record(body.storage) }),
      running: body.running === true || body.child === true,
      ...(typeof features.revision === "number"
        ? { revision: features.revision }
        : typeof body.revision === "number"
          ? { revision: body.revision }
          : {}),
    };
  } catch {
    return { ok: false, detail: "Worker is unreachable. Check the bundled service, then retry." };
  }
}

export function createFeatureService(deps: {
  settings: FeatureSettingsStore;
  config: AppConfig;
  fetch: typeof fetch;
  /** Optional so existing call sites keep working; defaults to recording nothing. */
  eventLog?: SystemEventLog;
  probeCacheMs?: number;
}): FeatureService {
  const { settings, config } = deps;
  const eventLog = deps.eventLog ?? noopSystemEventLog;
  // Per-process, so a restart re-emits one entry for a worker that is
  // still down rather than staying silent about it forever.
  const lastKnown = new Map<ProbeName, boolean>();
  const probes = new Map<string, () => Promise<Probe>>();
  function observe(url: string | undefined, runtimePort?: string) {
    const key = `${url}:${runtimePort}`;
    let cached = probes.get(key);
    if (!cached) {
      cached = createCachedProbe(() => probe(url, deps.fetch, runtimePort), {
        ttlMs: deps.probeCacheMs ?? 0,
      });
      probes.set(key, cached);
    }
    return cached();
  }

  /** Records only the edges of a worker's reachability, never every poll. */
  function recordProbe(name: ProbeName, worker: Probe | null): void {
    if (worker === null) return;
    const previous = lastKnown.get(name);
    lastKnown.set(name, worker.ok);
    if (previous === worker.ok) return;
    if (previous === undefined && worker.ok) return;
    if (worker.ok) {
      eventLog.record(PROBE_SUBSYSTEMS[name], "info", "Worker reachable again");
      return;
    }
    eventLog.record(
      PROBE_SUBSYSTEMS[name],
      "error",
      `Worker unreachable: ${worker.detail ?? "no detail"}`,
    );
  }
  const defaults: FeatureConfiguration = {
    version: 1,
    revision: 0,
    values: DISABLED_FEATURES,
    walkthroughComplete: false,
  };

  async function read(): Promise<{ raw: unknown | null; configuration: FeatureConfiguration }> {
    const raw = await settings.get<unknown>(FEATURES_SETTINGS_KEY);
    if (raw === null) return { raw, configuration: defaults };
    const parsed = FeatureConfiguration.safeParse(raw);
    if (!parsed.success)
      throw new ApiHttpError("internal", "Stored feature configuration is invalid.");
    return { raw, configuration: parsed.data };
  }

  return {
    async configuration() {
      return (await read()).configuration;
    },
    async enabled(feature) {
      return (await read()).configuration.values[feature];
    },
    async update(input) {
      const current = await read();
      if (input.revision !== current.configuration.revision) {
        throw new ApiHttpError(
          "conflict",
          "Feature settings changed in another session. Reload and try again.",
        );
      }
      const next: FeatureConfiguration = {
        version: 1,
        revision: input.revision + 1,
        values: input.values,
        walkthroughComplete: input.walkthroughComplete,
        ...(input.walkthroughStep === undefined ? {} : { walkthroughStep: input.walkthroughStep }),
      };
      if (!(await settings.compareAndSet(FEATURES_SETTINGS_KEY, current.raw, next))) {
        throw new ApiHttpError(
          "conflict",
          "Feature settings changed in another session. Reload and try again.",
        );
      }
      for (const id of FEATURE_IDS) {
        if (next.values[id] === current.configuration.values[id]) continue;
        eventLog.record(
          FEATURE_LOG_SUBSYSTEMS[id],
          "info",
          `Feature ${id} ${next.values[id] ? "enabled" : "disabled"}`,
        );
      }
      return next;
    },
    async status() {
      const { raw, configuration } = await read();
      const values = configuration.values;
      const roots = config.fdriveIndexRoots ?? [];
      const checkStorage = roots.length > 0;
      const needsIndex = values.thumbnails || values.textSearch || values.imageSearch;
      const observeDisabled = raw !== null;
      const [indexer, ocr, embed, image, tika] = await Promise.all([
        needsIndex || observeDisabled || checkStorage ? observe(config.fdriveIndexerUrl) : null,
        values.pdfOcr || observeDisabled || checkStorage ? observe(config.fdriveOcrUrl) : null,
        values.semanticSearch || observeDisabled ? observe(config.fdriveEmbedUrl, "8099") : null,
        values.imageSearch || observeDisabled ? observe(config.fdriveImageEmbedUrl, "8013") : null,
        values.textSearch ? observe("http://tika", "9997") : null,
      ]);
      recordProbe("indexer", indexer);
      recordProbe("ocr", ocr);
      recordProbe("embed", embed);
      recordProbe("image", image);
      const statuses = FEATURE_IDS.map((id): FeatureStatus => {
        if (!values[id]) {
          const worker =
            id === "pdfOcr"
              ? ocr
              : id === "semanticSearch"
                ? embed
                : id === "imageSearch"
                  ? image
                  : indexer;
          const stopping =
            worker?.values?.[id] === true ||
            (["pdfOcr", "semanticSearch", "imageSearch"].includes(id) &&
              (worker?.running === true || worker?.status === "stopping"));
          return {
            id,
            state: stopping ? "stopping" : "off",
            detail: stopping
              ? "New work is blocked. Waiting for the current operation to stop safely."
              : "Disabled. Existing index and cache data are retained.",
          };
        }
        if (roots.length === 0)
          return {
            id,
            state: "blocked",
            detail: "No local storage is mounted for processing. File browsing remains available.",
          };
        const storage = id === "pdfOcr" ? ocr?.storage : indexer?.storage;
        if (
          storage !== undefined &&
          roots.some(
            (root) =>
              record(storage[root.name]).readable !== true ||
              (id === "pdfOcr" && record(storage[root.name]).writable !== true),
          )
        ) {
          return {
            id,
            state: "blocked",
            detail:
              id === "pdfOcr"
                ? "The OCR worker needs readable and writable access to every configured root."
                : "The indexer cannot read every configured root. Check the deployment mount and permissions.",
          };
        }
        const workers =
          id === "pdfOcr"
            ? [ocr]
            : id === "semanticSearch"
              ? [indexer, embed, tika]
              : id === "imageSearch"
                ? [indexer, image]
                : id === "textSearch" || id === "searchOcr"
                  ? [indexer, tika]
                  : [indexer];
        const failed = workers.find((worker) => worker !== null && !worker.ok);
        if (failed)
          return { id, state: "failed", detail: failed.detail ?? "Worker is unavailable." };
        const preparationFailed = workers.find(
          (worker) => worker !== null && ["failed", "error"].includes(worker.status ?? ""),
        );
        if (preparationFailed) {
          // The controller's reason ("worker exceeded bounded startup
          // retries") is the line an operator needs first; it is a fixed
          // literal, never an upstream message.
          const reason = preparationFailed.error;
          return {
            id,
            state: "failed",
            detail:
              reason === undefined
                ? "Worker preparation failed. Check its System page and retry."
                : `Worker preparation failed: ${reason}. Check its System page and retry.`,
          };
        }
        if (
          workers.some(
            (worker) =>
              worker !== null &&
              (["loading", "preparing", "starting", "off", "stopping"].includes(
                worker.status ?? "",
              ) ||
                worker.revision !== configuration.revision),
          )
        ) {
          return {
            id,
            state: "preparing",
            detail: "Waiting for workers to apply this configuration and prepare processing.",
          };
        }
        return {
          id,
          state: "ready",
          detail: "Worker is ready. Existing files may still be processing.",
        };
      });
      return {
        configuration,
        source: raw === null ? "default" : "settings",
        statuses,
        roots: roots.map((root) => {
          const indexStorage = record(indexer?.storage?.[root.name]);
          const pdfStorage = record(ocr?.storage?.[root.name]);
          return {
            ...root,
            processing: {
              indexReadable:
                typeof indexStorage.readable === "boolean" ? indexStorage.readable : null,
              pdfReadable: typeof pdfStorage.readable === "boolean" ? pdfStorage.readable : null,
              pdfWritable: typeof pdfStorage.writable === "boolean" ? pdfStorage.writable : null,
            },
          };
        }),
      };
    },
  };
}
