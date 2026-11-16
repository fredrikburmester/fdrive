import { z } from "zod";
import { JobStatus } from "./jobs.ts";

/**
 * A change to files the signed-in login can reach, broadcast over
 * `/api/v1/events` (SSE) so open browser tabs refresh what they show without
 * polling. It comes from one row of the change journal, mapped into the
 * login's own paths, and carries the row's position as its SSE `id`.
 *
 * `move`: `paths[0]` moved to `targetPaths[0]`. `change`: look at `paths`
 * again; what is there is new, changed or gone.
 */
export const FsEvent = z.object({
  type: z.literal("fs"),
  op: z.enum(["change", "move"]),
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
 * Changes since the position the browser resumed from are no longer known
 * (the journal dropped them, or the database was restored): refetch what is
 * on screen. Live events follow from its `id`.
 */
export const ResyncEvent = z.object({
  type: z.literal("resync"),
  at: z.iso.datetime(),
});

export type ResyncEvent = z.infer<typeof ResyncEvent>;

/**
 * The index took in a change (a file's row and thumbnails are ready, or rows
 * moved or went), so what it backs, such as folder sizes, may differ. It
 * names no path and has no `id`.
 */
export const IndexedEvent = z.object({
  type: z.literal("indexed"),
  at: z.iso.datetime(),
});

export type IndexedEvent = z.infer<typeof IndexedEvent>;

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

export const SseEvent = z.discriminatedUnion("type", [
  FsEvent,
  PingEvent,
  ResyncEvent,
  IndexedEvent,
  JobEvent,
]);

export type SseEvent = z.infer<typeof SseEvent>;

/**
 * An `fs` or `resync` event's SSE `id`, which a browser sends back as
 * `Last-Event-ID` (or as the `lastEventId` query parameter when it
 * reconnects itself): the change journal's epoch and a position in it,
 * `<epoch>.<position>`.
 */
export const SSE_EVENT_ID = /^([0-9a-f-]{36})\.(\d{1,15})$/;
