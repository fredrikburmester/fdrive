import { z } from "zod";

export const FEATURE_IDS = [
  "thumbnails",
  "textSearch",
  "searchOcr",
  "semanticSearch",
  "imageSearch",
  "pdfOcr",
] as const;
export const FeatureId = z.enum(FEATURE_IDS);
export type FeatureId = z.infer<typeof FeatureId>;

export const FeatureValues = z
  .object({
    thumbnails: z.boolean(),
    textSearch: z.boolean(),
    searchOcr: z.boolean(),
    semanticSearch: z.boolean(),
    imageSearch: z.boolean(),
    pdfOcr: z.boolean(),
  })
  .strict();
export type FeatureValues = z.infer<typeof FeatureValues>;

export const FeatureConfiguration = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  values: FeatureValues,
  walkthroughComplete: z.boolean(),
  walkthroughStep: z.number().int().min(0).max(8).optional(),
});
export type FeatureConfiguration = z.infer<typeof FeatureConfiguration>;

export const FeaturesUpdateRequest = z
  .object({
    revision: z.number().int().nonnegative(),
    values: FeatureValues,
    walkthroughComplete: z.boolean(),
    walkthroughStep: z.number().int().min(0).max(8).optional(),
  })
  .strict()
  .refine(
    (value) => value.values.textSearch || (!value.values.searchOcr && !value.values.semanticSearch),
    {
      message: "Search OCR and semantic search require full-text search.",
      path: ["values", "textSearch"],
    },
  );
export type FeaturesUpdateRequest = z.infer<typeof FeaturesUpdateRequest>;

export const FeatureStatus = z.object({
  id: FeatureId,
  state: z.enum(["off", "preparing", "ready", "blocked", "failed", "stopping"]),
  detail: z.string(),
});
export type FeatureStatus = z.infer<typeof FeatureStatus>;

export const SystemFeaturesResponse = z.object({
  configuration: FeatureConfiguration,
  source: z.enum(["default", "settings"]),
  statuses: z.array(FeatureStatus),
  roots: z.array(
    z.object({
      name: z.string(),
      sftpgoPath: z.string(),
      indexerPath: z.string(),
      processing: z
        .object({
          indexReadable: z.boolean().nullable(),
          pdfReadable: z.boolean().nullable(),
          pdfWritable: z.boolean().nullable(),
        })
        .optional(),
    }),
  ),
});
export type SystemFeaturesResponse = z.infer<typeof SystemFeaturesResponse>;

export const FEATURES_SETTINGS_KEY = "features.configuration";
export const WORKER_TOKEN_HEADER = "x-fdrive-worker-token";
