import { z } from "zod";
import { FeatureId } from "./features.ts";

export const SystemActivityId = z.enum([
  "features",
  "general",
  "storage",
  "sharedFolders",
  "thumbnails",
  "textSearch",
  "semanticSearch",
  "pdfOcr",
  "imageSearch",
  "office",
]);
export type SystemActivityId = z.infer<typeof SystemActivityId>;

/** Small, path-free snapshots from the workers. Totals stay null during discovery. */
export const ActivityOperation = z.object({
  id: z.string(),
  kind: z.enum([
    "scan",
    "watch",
    "reindex",
    "thumbnailRebuild",
    "thumbnailClear",
    "indexClear",
    "imageRebuild",
    "imageClear",
    "ocr",
  ]),
  features: z.array(FeatureId),
  revision: z.number().int().nonnegative(),
  state: z.enum(["running", "waiting", "completed", "failed", "stopped"]),
  phase: z.enum(["discovering", "processing", "queued", "waiting"]),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  errors: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  unit: z.enum(["files", "entries"]),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ActivityOperation = z.infer<typeof ActivityOperation>;

export const WorkerActivity = z.object({
  instanceId: z.string(),
  observedAt: z.iso.datetime({ offset: true }),
  operations: z.array(ActivityOperation),
});
export type WorkerActivity = z.infer<typeof WorkerActivity>;

export const SystemActivityItem = z.object({
  id: SystemActivityId,
  state: z.enum(["idle", "working", "waiting", "unavailable", "failed"]),
  percent: z.number().int().min(0).max(100).nullable(),
  detail: z.string(),
  warning: z.boolean(),
  operationIds: z.array(z.string()),
});
export type SystemActivityItem = z.infer<typeof SystemActivityItem>;

export const SystemActivityResponse = z.object({
  observedAt: z.iso.datetime({ offset: true }),
  items: z.array(SystemActivityItem),
});
export type SystemActivityResponse = z.infer<typeof SystemActivityResponse>;
