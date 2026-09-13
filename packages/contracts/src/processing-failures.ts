import { z } from "zod";

export const ProcessingFeature = z.enum([
  "thumbnails",
  "textSearch",
  "semanticSearch",
  "imageSearch",
]);
export type ProcessingFeature = z.infer<typeof ProcessingFeature>;

export const ProcessingFailuresQuery = z.object({
  status: z.enum(["open", "resolved"]).default("open"),
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  code: z.string().max(100).optional(),
});
export type ProcessingFailuresQuery = z.infer<typeof ProcessingFailuresQuery>;

export const ProcessingFailure = z.object({
  id: z.number().int().positive(),
  root: z.string(),
  path: z.string(),
  feature: ProcessingFeature,
  code: z.string(),
  message: z.string(),
  operationId: z.string(),
  attempts: z.number().int().positive(),
  firstFailedAt: z.iso.datetime({ offset: true }),
  lastFailedAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ProcessingFailure = z.infer<typeof ProcessingFailure>;

export const ProcessingFailuresResponse = z.object({
  entries: z.array(ProcessingFailure),
  groups: z.array(z.object({ code: z.string(), count: z.number().int().nonnegative() })),
  total: z.number().int().nonnegative(),
  openCount: z.number().int().nonnegative(),
  nextCursor: z.number().int().positive().optional(),
});
export type ProcessingFailuresResponse = z.infer<typeof ProcessingFailuresResponse>;

export const RetryProcessingFailuresRequest = z
  .object({ id: z.number().int().positive().optional() })
  .strict();
export type RetryProcessingFailuresRequest = z.infer<typeof RetryProcessingFailuresRequest>;
export const RetryProcessingFailuresResponse = z.object({
  started: z.literal(true),
  operationId: z.string(),
});
export type RetryProcessingFailuresResponse = z.infer<typeof RetryProcessingFailuresResponse>;
