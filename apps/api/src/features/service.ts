import {
  FEATURE_IDS,
  FEATURES_SETTINGS_KEY,
  FeatureConfiguration,
  type FeatureId,
  type FeatureStatus,
  type FeaturesUpdateRequest,
  type FeatureValues,
  type SystemFeaturesResponse,
} from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";

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
    return {
      ok: body.ok !== false,
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
}): FeatureService {
  const { settings, config } = deps;
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
        needsIndex || observeDisabled || checkStorage
          ? probe(config.fdriveIndexerUrl, deps.fetch)
          : null,
        values.pdfOcr || observeDisabled || checkStorage
          ? probe(config.fdriveOcrUrl, deps.fetch)
          : null,
        values.semanticSearch || observeDisabled
          ? probe(config.fdriveEmbedUrl, deps.fetch, "8099")
          : null,
        values.imageSearch || observeDisabled
          ? probe(config.fdriveImageEmbedUrl, deps.fetch, "8013")
          : null,
        values.textSearch ? probe("http://tika", deps.fetch, "9997") : null,
      ]);
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
        if (
          workers.some(
            (worker) => worker !== null && ["failed", "error"].includes(worker.status ?? ""),
          )
        ) {
          return {
            id,
            state: "failed",
            detail: "Worker preparation failed. Check its System page and retry.",
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
