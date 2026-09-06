import { z } from "zod";
import { JobStatus } from "./jobs.ts";

/**
 * A change to the filesystem, broadcast over `/api/v1/events` (SSE) so open
 * browser tabs can refresh affected listings without polling.
 */
export const FsEvent = z.object({
  type: z.literal("fs"),
  op: z.enum(["create", "update", "delete", "move", "copy", "mkdir"]),
  identityId: z.uuid(),
  paths: z.array(z.string()),
  targetPaths: z.array(z.string()).optional(),
  at: z.iso.datetime(),
});

export type FsEvent = z.infer<typeof FsEvent>;

/** Keep-alive event sent periodically so proxies do not close the stream. */
export const PingEvent = z.object({
  type: z.literal("ping"),
  at: z.iso.datetime(),
});

export type PingEvent = z.infer<typeof PingEvent>;

/**
 * A job's state or progress changed, broadcast over `/api/v1/events` (SSE)
 * so the Activity panel can show live progress without polling
 * `GET /fs/jobs/:id`.
 */
export const JobEvent = z.object({
  type: z.literal("job"),
  job: JobStatus,
  at: z.iso.datetime(),
});

export type JobEvent = z.infer<typeof JobEvent>;

export const SseEvent = z.discriminatedUnion("type", [FsEvent, PingEvent, JobEvent]);

export type SseEvent = z.infer<typeof SseEvent>;
