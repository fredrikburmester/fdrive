import { z } from "zod";

/**
 * Whether a value backing one of the System pages' settings forms came from
 * the sidecar's env-derived default or from an explicit override in
 * `app.settings`. Shown next to each field so an admin can tell what they
 * are about to change.
 */
export const SettingSource = z.enum(["default", "settings"]);

export type SettingSource = z.infer<typeof SettingSource>;

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

/** Shape of `GET /api/v1/system/indexer`'s `health` field, mirrored from the indexer's `GET /health`. */
export const IndexerHealth = z.object({
  ok: z.boolean(),
  roots: z.array(z.string()),
  watcher: z.record(z.string(), z.boolean()),
  embedOk: z.boolean(),
  schemaVersion: z.number().int().nullable(),
});

export type IndexerHealth = z.infer<typeof IndexerHealth>;

/**
 * One root's most recent completed scan, mirrored from the indexer's
 * `idx.scans`. The indexer is Python and emits `datetime.isoformat()`, which
 * renders UTC as a `+00:00` offset rather than a `Z` suffix, so both
 * timestamps must accept an explicit offset.
 */
export const IndexerLastScan = z.object({
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  filesSeen: z.number().int(),
  filesChanged: z.number().int(),
  filesDeleted: z.number().int(),
  errors: z.number().int(),
});

export type IndexerLastScan = z.infer<typeof IndexerLastScan>;

/** Per-root counts, mirrored from one entry of the indexer's `GET /stats`'s `roots` array. */
export const IndexerRootStats = z.object({
  root: z.string(),
  countsByStatus: z.record(z.string(), z.number().int()),
  chunks: z.number().int(),
  chunksEmbedded: z.number().int(),
  lastScan: IndexerLastScan.nullable(),
});

export type IndexerRootStats = z.infer<typeof IndexerRootStats>;

/** One recent extraction failure, mirrored from the indexer's `errors_sample`. */
export const IndexerErrorSample = z.object({
  path: z.string(),
  error: z.string().nullable(),
});

export type IndexerErrorSample = z.infer<typeof IndexerErrorSample>;

/**
 * Progress of the most recent `POST /api/v1/system/indexer/thumbnails/rebuild`
 * pass, mirrored from the indexer's `GET /stats`'s `thumbnail_rebuild` field.
 * All zero/`null`/`false` when no rebuild has run since the indexer started.
 * Optional here (rather than on `IndexerStats` itself) so an older indexer
 * that does not emit this field still parses.
 */
export const IndexerThumbnailRebuildJob = z.object({
  running: z.boolean(),
  processed: z.number().int(),
  total: z.number().int(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  errors: z.number().int(),
});

export type IndexerThumbnailRebuildJob = z.infer<typeof IndexerThumbnailRebuildJob>;

/** Progress shared by index, thumbnail, and image-embedding clear passes. */
export const IndexerClearJob = IndexerThumbnailRebuildJob;

export type IndexerClearJob = z.infer<typeof IndexerClearJob>;

/**
 * Progress of the most recent
 * `POST /api/v1/system/search/image-embeddings/rebuild` pass, mirrored from
 * the indexer's `GET /stats`'s `image_embedding_rebuild` field. Same shape
 * as `IndexerThumbnailRebuildJob`.
 */
export const ImageEmbeddingRebuildJob = IndexerThumbnailRebuildJob;

export type ImageEmbeddingRebuildJob = z.infer<typeof ImageEmbeddingRebuildJob>;

/** Progress of the most recent `POST /api/v1/system/search/image-embeddings/clear` pass. */
export const ImageEmbeddingClearJob = IndexerThumbnailRebuildJob;

export type ImageEmbeddingClearJob = z.infer<typeof ImageEmbeddingClearJob>;

/** Clear all roots, one root, or an exact file or directory subtree. */
export const IndexerClearRequest = z
  .strictObject({
    root: z.string().min(1).regex(/\S/).optional(),
    path: z
      .string()
      .min(1)
      .regex(/\S/)
      .refine((value) => !/(^|\/)\.\.(\/|$)|[\\\0]/.test(value), "invalid path")
      .optional(),
  })
  .refine((value) => value.path === undefined || value.root !== undefined, {
    message: "path requires root",
    path: ["path"],
  });

export type IndexerClearRequest = z.infer<typeof IndexerClearRequest>;

/** Admission response. Discovery and deletion run in the background. */
export const IndexerClearResponse = z.object({ started: z.boolean() });

export type IndexerClearResponse = z.infer<typeof IndexerClearResponse>;

/** Shape of `GET /api/v1/system/indexer`'s `stats` field, mirrored from the indexer's `GET /stats`. */
export const IndexerStats = z.object({
  roots: z.array(IndexerRootStats),
  thumbnails: z.number().int(),
  queueDepth: z.number().int(),
  errorsSample: z.array(IndexerErrorSample),
  thumbnailRebuild: IndexerThumbnailRebuildJob.optional(),
  indexClear: IndexerClearJob.optional(),
  thumbnailClear: IndexerClearJob.optional(),
  /** Count of embedded image thumbnails, mirrored from the indexer's `image_embeddings`. */
  imageEmbeddings: z.number().int().optional(),
  imageEmbeddingRebuild: ImageEmbeddingRebuildJob.optional(),
  imageEmbeddingClear: ImageEmbeddingClearJob.optional(),
});

export type IndexerStats = z.infer<typeof IndexerStats>;

/** The five settings keys the indexer reads from `app.settings` at the start of every scan cycle. */
export const IndexerSettingsValue = z.object({
  scanIntervalSeconds: z.number().int(),
  workers: z.number().int(),
  textExcludeGlobs: z.array(z.string()),
  ocrImageGlobs: z.array(z.string()),
  tesseractLangs: z.string(),
});

export type IndexerSettingsValue = z.infer<typeof IndexerSettingsValue>;

/** `IndexerSettingsValue`'s fields, marked with where each currently resolved value came from. */
export const IndexerSettingsSources = z.object({
  scanIntervalSeconds: SettingSource,
  workers: SettingSource,
  textExcludeGlobs: SettingSource,
  ocrImageGlobs: SettingSource,
  tesseractLangs: SettingSource,
});

export type IndexerSettingsSources = z.infer<typeof IndexerSettingsSources>;

/** The `settings` field shared by `GET /api/v1/system/indexer` and the response to updating it. */
export const IndexerSettingsResponse = z.object({
  values: IndexerSettingsValue,
  sources: IndexerSettingsSources,
});

export type IndexerSettingsResponse = z.infer<typeof IndexerSettingsResponse>;

/** Response for `GET /api/v1/system/indexer`. */
export const SystemIndexerResponse = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  health: IndexerHealth.optional(),
  stats: IndexerStats.optional(),
  settings: IndexerSettingsResponse,
});

export type SystemIndexerResponse = z.infer<typeof SystemIndexerResponse>;

/**
 * Body for `PUT /api/v1/system/indexer/settings`. Ranges match
 * `docs/INDEXER.md`'s documented bounds: an interval and worker count too
 * small would thrash the box, one too large would leave changes invisible
 * for hours.
 */
export const IndexerSettingsUpdateRequest = z.object({
  scanIntervalSeconds: z.number().int().min(30).max(86400),
  workers: z.number().int().min(1).max(16),
  textExcludeGlobs: z.array(z.string().min(1)),
  ocrImageGlobs: z.array(z.string().min(1)),
  tesseractLangs: z.string().min(1),
});

export type IndexerSettingsUpdateRequest = z.infer<typeof IndexerSettingsUpdateRequest>;

/**
 * Body for `POST /api/v1/system/indexer/reindex`. `path` omitted marks the
 * whole root. `thumbnails: true` also starts a thumbnail-rebuild pass (see
 * `IndexerThumbnailsRebuildRequest`) over the same scope after marking rows
 * pending; unlike the reindex itself, this is best-effort and not reported
 * back (it is silently skipped if a rebuild is already running).
 */
export const IndexerReindexRequest = z.object({
  root: z.string().min(1),
  path: z.string().min(1).optional(),
  thumbnails: z.boolean().optional(),
});

export type IndexerReindexRequest = z.infer<typeof IndexerReindexRequest>;

/** Response for `POST /api/v1/system/indexer/reindex` and `POST /api/v1/system/search/reembed`. */
export const IndexerActionResponse = z.object({
  marked: z.number().int(),
});

export type IndexerActionResponse = z.infer<typeof IndexerActionResponse>;

/**
 * Body for `POST /api/v1/system/indexer/thumbnails/rebuild` (and the legacy
 * `POST /api/v1/system/thumbnails/rebuild`, which always omits all three).
 * `root` omitted rebuilds every configured root; `path` omitted rebuilds the
 * whole root (a single file or directory subtree otherwise). `force: true`
 * deletes and rewrites thumbnails that already exist; without it, only
 * thumbnails missing on disk are generated. This is thumbnail-only: unlike
 * `IndexerReindexRequest`, text extraction, chunking, and embeddings are
 * never touched.
 */
export const IndexerThumbnailsRebuildRequest = z.object({
  root: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

export type IndexerThumbnailsRebuildRequest = z.infer<typeof IndexerThumbnailsRebuildRequest>;

/**
 * Response for `POST /api/v1/system/indexer/thumbnails/rebuild` and the
 * legacy `POST /api/v1/system/thumbnails/rebuild`. The pass runs in the
 * background, so this reports whether it started and the candidate count
 * computed up front (not a final count); progress while it runs is visible
 * at `GET /api/v1/system/indexer` under `stats.thumbnailRebuild`.
 */
export const IndexerThumbnailsRebuildResponse = z.object({
  started: z.boolean(),
  total: z.number().int(),
});

export type IndexerThumbnailsRebuildResponse = z.infer<typeof IndexerThumbnailsRebuildResponse>;

// ---------------------------------------------------------------------------
// Search and embeddings
// ---------------------------------------------------------------------------

/** The TEI embedding server's reachability and model info, shown on the Search page. */
export const SemanticStatus = z.object({
  configured: z.boolean(),
  healthy: z.boolean(),
  model: z.string().optional(),
  maxInputLength: z.number().int().optional(),
});

export type SemanticStatus = z.infer<typeof SemanticStatus>;

/** Aggregate index totals across every configured root, admin-wide (not identity-scoped). */
export const SystemIndexTotals = z.object({
  files: z.number().int(),
  withText: z.number().int(),
  chunks: z.number().int(),
  embedded: z.number().int(),
});

export type SystemIndexTotals = z.infer<typeof SystemIndexTotals>;

/** Response for `GET /api/v1/system/search`. */
export const SystemSearchResponse = z.object({
  configured: z.boolean(),
  semantic: SemanticStatus,
  roots: z.array(z.string()),
  index: SystemIndexTotals,
});

export type SystemSearchResponse = z.infer<typeof SystemSearchResponse>;

/**
 * Response for `POST /api/v1/system/search/reembed`. Today this proxies a
 * full re-extraction (the indexer's `/reindex` with no `path`, once per
 * root) rather than a narrower re-embed-only pass; `marked` sums every
 * root's marked-file count.
 */
export const SystemReembedResponse = z.object({
  marked: z.number().int(),
  roots: z.array(z.string()),
});

export type SystemReembedResponse = z.infer<typeof SystemReembedResponse>;

/**
 * Response for `GET /api/v1/system/image-search`. `configured` is false when
 * `FDRIVE_IMAGE_EMBED_URL` is unset. `model`/`dim` mirror the sidecar's own
 * `/health` (present only when reachable). `embedded`/`embeddedModel` are
 * mirrored from `IndexQueries.imageEmbeddingStats`; `embeddedModel` is `null`
 * when no thumbnail has been embedded yet. `rebuild`/`clear` mirror the
 * indexer's `image_embedding_rebuild`/`image_embedding_clear` stats.
 */
export const SystemImageSearchResponse = z.object({
  configured: z.boolean(),
  healthy: z.boolean(),
  model: z.string().optional(),
  dim: z.number().int().optional(),
  embedded: z.number().int(),
  embeddedModel: z.string().nullable(),
  rebuild: IndexerThumbnailRebuildJob.optional(),
  clear: IndexerClearJob.optional(),
});

export type SystemImageSearchResponse = z.infer<typeof SystemImageSearchResponse>;

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

/** Shape of `GET /api/v1/system/ocr`'s `health` field, mirrored from the OCR service's `GET /health`. */
export const OcrHealth = z.object({
  ok: z.boolean(),
  running: z.boolean(),
});

export type OcrHealth = z.infer<typeof OcrHealth>;

/**
 * The OCR service's most recent nightly run. Also a Python service (see
 * `IndexerLastScan`), so both timestamps must accept a `+00:00`-style offset.
 */
export const OcrLastRun = z.object({
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  seen: z.number().int(),
  ocred: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
});

export type OcrLastRun = z.infer<typeof OcrLastRun>;

/** Shape of `GET /api/v1/system/ocr`'s `stats` field, mirrored from the OCR service's `GET /stats`. */
export const OcrStats = z.object({
  lastRun: OcrLastRun.nullable(),
  nextRunAt: z.iso.datetime({ offset: true }).nullable(),
  scheduleHour: z.number().int().min(0).max(23),
  langs: z.string(),
  excludeGlobs: z.array(z.string()),
  maxMb: z.number().int(),
  keepOriginals: z.boolean(),
  originalsCount: z.number().int(),
  originalsBytes: z.number().int(),
  running: z.boolean(),
});

export type OcrStats = z.infer<typeof OcrStats>;

/** The five settings keys the OCR service reads from `app.settings`. */
export const OcrSettingsValue = z.object({
  hour: z.number().int().min(0).max(23),
  langs: z.string(),
  excludeGlobs: z.array(z.string()),
  maxMb: z.number().int(),
  keepOriginals: z.boolean(),
});

export type OcrSettingsValue = z.infer<typeof OcrSettingsValue>;

/** `OcrSettingsValue`'s fields, marked with where each currently resolved value came from. */
export const OcrSettingsSources = z.object({
  hour: SettingSource,
  langs: SettingSource,
  excludeGlobs: SettingSource,
  maxMb: SettingSource,
  keepOriginals: SettingSource,
});

export type OcrSettingsSources = z.infer<typeof OcrSettingsSources>;

/** The `settings` field shared by `GET /api/v1/system/ocr` and the response to updating it. */
export const OcrSettingsResponse = z.object({
  values: OcrSettingsValue,
  sources: OcrSettingsSources,
});

export type OcrSettingsResponse = z.infer<typeof OcrSettingsResponse>;

/** Response for `GET /api/v1/system/ocr`. `configured` is false when `FDRIVE_OCR_URL` is unset. */
export const SystemOcrResponse = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  health: OcrHealth.optional(),
  stats: OcrStats.optional(),
  settings: OcrSettingsResponse,
});

export type SystemOcrResponse = z.infer<typeof SystemOcrResponse>;

/** Body for `PUT /api/v1/system/ocr/settings`. */
export const OcrSettingsUpdateRequest = z.object({
  hour: z.number().int().min(0).max(23),
  langs: z.string().min(1),
  excludeGlobs: z.array(z.string().min(1)),
  maxMb: z.number().int().min(1),
  keepOriginals: z.boolean(),
});

export type OcrSettingsUpdateRequest = z.infer<typeof OcrSettingsUpdateRequest>;

/** Response for `POST /api/v1/system/ocr/run`, mirrored from the OCR service's 202 `{ started: true }`. */
export const OcrRunResponse = z.object({
  started: z.boolean(),
});

export type OcrRunResponse = z.infer<typeof OcrRunResponse>;

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** Response for `GET /api/v1/system/thumbnails`. */
export const SystemThumbnailsResponse = z.object({
  configured: z.boolean(),
  count: z.number().int().min(0),
  bytes: z.number().int().min(0),
});

export type SystemThumbnailsResponse = z.infer<typeof SystemThumbnailsResponse>;

/** Internal indexer directory metadata. Overflow makes scope verification inconclusive. */
export const IndexerDirectoryResponse = z.strictObject({
  items: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^/\0]+$/u),
        kind: z.enum(["file", "dir", "symlink", "other"]),
      }),
    )
    .max(10000),
  overflow: z.boolean(),
});
export type IndexerDirectoryResponse = z.infer<typeof IndexerDirectoryResponse>;
