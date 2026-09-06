import { z } from "zod";

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

export const SseEvent = z.discriminatedUnion("type", [FsEvent, PingEvent]);

export type SseEvent = z.infer<typeof SseEvent>;
