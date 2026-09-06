import { z } from "zod";

/**
 * The archive formats fdrive's compress job can produce. Mirrors
 * `@fdrive/core`'s own `ArchiveFormat` union.
 */
export const ArchiveFormat = z.enum(["zip", "tar.gz", "tar.zst"]);

export type ArchiveFormat = z.infer<typeof ArchiveFormat>;

/** The kinds of long-running filesystem job the API runs. */
export const JobKind = z.enum(["compress", "extract"]);

export type JobKind = z.infer<typeof JobKind>;

/** The lifecycle states of a job. */
export const JobState = z.enum(["queued", "running", "done", "failed", "cancelled"]);

export type JobState = z.infer<typeof JobState>;

export const JobProgress = z.object({
  processed: z.number().int().min(0),
  total: z.number().int().min(0).nullable(),
  bytes: z.number().int().min(0),
});

export type JobProgress = z.infer<typeof JobProgress>;

/**
 * A job's full status, as returned by `GET /fs/jobs`, `GET /fs/jobs/:id`,
 * `POST /fs/jobs/:id/cancel`, and broadcast in every `JobEvent`.
 */
export const JobStatus = z.object({
  id: z.string(),
  kind: JobKind,
  state: JobState,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  progress: JobProgress,
  result: z.object({ path: z.string() }).optional(),
  error: z.string().optional(),
});

export type JobStatus = z.infer<typeof JobStatus>;

/** Returned with 202 by `POST /fs/compress` and `POST /fs/extract`. */
export const JobAccepted = z.object({
  jobId: z.string(),
});

export type JobAccepted = z.infer<typeof JobAccepted>;

/** Returned by `GET /fs/jobs`. */
export const JobsResponse = z.object({
  jobs: z.array(JobStatus),
});

export type JobsResponse = z.infer<typeof JobsResponse>;
