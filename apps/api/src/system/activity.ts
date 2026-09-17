import {
  type ActivityOperation,
  type FeatureId,
  ROUTES,
  SystemActivityId,
  type SystemActivityItem,
  type SystemActivityResponse,
  type SystemFeaturesResponse,
  type SystemOfficeResponse,
  WorkerActivity,
} from "@fdrive/contracts";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { createCachedProbe } from "./cached-probe.js";
import { callSidecar, type SidecarResult } from "./sidecar-client.js";

const FEATURE_ITEM: Record<FeatureId, SystemActivityId> = {
  thumbnails: "thumbnails",
  textSearch: "textSearch",
  searchOcr: "textSearch",
  semanticSearch: "semanticSearch",
  imageSearch: "imageSearch",
  pdfOcr: "pdfOcr",
};
const FEATURE_LABELS: Partial<Record<SystemActivityId, string>> = {
  thumbnails: "Thumbnails",
  textSearch: "Full-text search",
  semanticSearch: "Semantic search",
  pdfOcr: "Searchable PDFs",
  imageSearch: "Image search",
};
const LABELS: Record<ActivityOperation["kind"], string> = {
  scan: "Indexing files",
  watch: "Processing changes",
  reindex: "Reindexing files",
  thumbnailRebuild: "Rebuilding previews",
  thumbnailClear: "Clearing previews",
  indexClear: "Clearing index",
  imageRebuild: "Embedding images",
  imageClear: "Clearing image embeddings",
  ocr: "Making PDFs searchable",
};

function operationDetail(operation: ActivityOperation): string {
  const phase =
    operation.phase === "discovering"
      ? "Discovering files"
      : operation.phase === "queued"
        ? "Queued"
        : operation.phase === "waiting"
          ? "Waiting for worker"
          : LABELS[operation.kind];
  const count =
    operation.total === null
      ? `${operation.processed.toLocaleString("en")} ${operation.unit} processed`
      : `${operation.processed.toLocaleString("en")} of ${operation.total.toLocaleString("en")} ${operation.unit} processed`;
  const result =
    operation.state === "stopped"
      ? " · Stopped"
      : operation.state === "failed"
        ? " · Finished with errors"
        : "";
  return `${phase}: ${count}${operation.errors ? ` · ${operation.errors} errors` : ""}${result}`;
}

/** All totals must describe the same kind of work; coverage totals are never used. */
export function activityPercent(operations: readonly ActivityOperation[]): number | null {
  const first = operations[0];
  if (
    !first ||
    operations.some(
      (operation) =>
        operation.state !== "running" ||
        operation.phase !== "processing" ||
        operation.total === null ||
        operation.kind !== first.kind ||
        operation.unit !== first.unit,
    )
  )
    return null;
  const total = operations.reduce((sum, operation) => sum + (operation.total ?? 0), 0);
  if (total === 0) return null;
  return Math.min(
    99,
    Math.floor((100 * operations.reduce((sum, operation) => sum + operation.processed, 0)) / total),
  );
}

type Observation = SidecarResult<WorkerActivity> | null;

export function shapeSystemActivity(
  features: SystemFeaturesResponse | null,
  office: SystemOfficeResponse["status"] | null,
  indexer: Observation,
  ocr: Observation,
  now: string,
): SystemActivityResponse {
  const observations = [indexer, ocr];
  const operations = observations.flatMap((source) =>
    source?.ok
      ? source.data.operations.map((operation) => ({
          ...operation,
          id: `${source.data.instanceId}:${operation.id}`,
        }))
      : [],
  );
  const items = SystemActivityId.options.map((id): SystemActivityItem => {
    const statuses = features?.statuses.filter((status) => FEATURE_ITEM[status.id] === id) ?? [];
    const relevant = operations.filter((operation) =>
      operation.features.some((feature) => FEATURE_ITEM[feature] === id),
    );
    const active = relevant.filter(
      (operation) => operation.state === "running" || operation.state === "waiting",
    );
    const failures = relevant.filter(
      (operation) => operation.state === "failed" || operation.state === "stopped",
    );
    const transitioning = statuses.filter(
      (status) => status.state === "preparing" || status.state === "stopping",
    );
    const failed = statuses.filter(
      (status) => status.state === "failed" || status.state === "blocked",
    );
    const source = id === "pdfOcr" ? ocr : indexer;
    const needsTelemetry = statuses.some((status) => status.state !== "off");
    const missing = needsTelemetry && !source?.ok;
    const working =
      active.some((operation) => operation.state === "running") ||
      transitioning.length > 0 ||
      (id === "office" && office === "starting");
    const unavailable =
      (missing && !transitioning.length) ||
      (id === "office" && (office === null || office === "unavailable")) ||
      (features === null && Object.values(FEATURE_ITEM).includes(id));
    const details = [
      ...transitioning.map((status) => status.detail),
      ...failed.map((status) => status.detail),
      ...active.map(operationDetail),
      ...(active.length === 0 ? failures.map(operationDetail) : []),
    ];
    if (missing) details.push("Processing status unavailable.");
    if (features === null && FEATURE_LABELS[id]) details.push("Feature status unavailable.");
    if (id === "office" && office === "starting") details.push("Starting Office.");
    if (id === "office" && unavailable) details.push("Office status unavailable.");
    return {
      id,
      state: working
        ? "working"
        : active.length
          ? "waiting"
          : failed.length || failures.length
            ? "failed"
            : unavailable
              ? "unavailable"
              : "idle",
      percent: transitioning.length || missing ? null : activityPercent(active),
      detail: [...new Set(details)].join("\n"),
      warning:
        missing ||
        unavailable ||
        failed.length > 0 ||
        failures.length > 0 ||
        active.some((operation) => operation.errors > 0),
      operationIds: relevant.map((operation) => operation.id),
    };
  });
  const overview = items.find((item) => item.id === "features");
  const featureItems = items.filter(
    (item) => Object.values(FEATURE_ITEM).includes(item.id) && item.state !== "idle",
  );
  if (overview && featureItems.length) {
    overview.state = featureItems.some((item) => item.state === "working")
      ? "working"
      : featureItems.some((item) => item.state === "waiting")
        ? "waiting"
        : "failed";
    overview.warning = featureItems.some((item) => item.warning);
    overview.detail = featureItems
      .map((item) => `${FEATURE_LABELS[item.id]}: ${item.detail}`)
      .join("\n");
  }
  return { observedAt: now, items };
}

export function registerActivityRoutes(
  groups: { authed: AuthedHono },
  deps: {
    indexerUrl: string | undefined;
    ocrUrl: string | undefined;
    fetch: typeof globalThis.fetch;
    features: () => Promise<SystemFeaturesResponse>;
    office: () => Promise<SystemOfficeResponse>;
  },
) {
  const observe = (url: string | undefined) =>
    url === undefined
      ? Promise.resolve(null)
      : callSidecar(url, "/activity", WorkerActivity, {}, { fetch: deps.fetch });
  const read = createCachedProbe(
    async () => {
      const observedAt = new Date().toISOString();
      const [features, office, indexer, ocr] = await Promise.all([
        deps.features().catch(() => null),
        deps
          .office()
          .then((value) => value.status)
          .catch(() => null),
        observe(deps.indexerUrl),
        observe(deps.ocrUrl),
      ]);
      return shapeSystemActivity(features, office, indexer, ocr, observedAt);
    },
    { ttlMs: 2000 },
  );
  groups.authed.get(withoutApiV1Prefix(ROUTES.system.activity), createRequireAdmin(), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await read());
  });
}
