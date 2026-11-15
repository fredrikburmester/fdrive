import { ROUTES, SSE_EVENT_ID, type SseEvent } from "@fdrive/contracts";
import { streamSSE } from "hono/streaming";
import type { AppHono, AuthedHono } from "../app.js";
import type { BusEvent, EventBus } from "./bus.js";
import type { JournalFanout } from "./journal.ts";

const API_PREFIX = "/api/v1";
const DEFAULT_PING_INTERVAL_MS = 25_000;

export interface EventRoutesDeps {
  readonly bus: EventBus;
  readonly journal: Pick<JournalFanout, "epoch" | "position" | "replay">;
  readonly clock: () => Date;
  readonly pingIntervalMs?: number;
}

/** The bus's event as the browser gets it, without the login and position the bus routes by. */
function toWireEvent(event: BusEvent): SseEvent {
  if (event.type === "indexed") return event;
  if (event.type === "fs") {
    const { identityId: _identityId, position: _position, ...fsEvent } = event;
    return fsEvent;
  }
  const { identityId: _identityId, ...jobEvent } = event;
  return jobEvent;
}

/**
 * The position a browser resumes from: `null` when it sent no id, `"other"`
 * when the id is unreadable or from another epoch (positions start again
 * after a restore).
 */
function resumeFrom(id: string | undefined, epoch: string): number | null | "other" {
  if (id === undefined || id === "") return null;
  const match = SSE_EVENT_ID.exec(id);
  return match?.[1] === epoch ? Number(match[2]) : "other";
}

/**
 * Registers `GET /events`: a Server-Sent Events stream of what changes in
 * the caller's files, from the change journal (`events/journal.ts`), plus
 * the caller's job progress and the index's `indexed` signal.
 *
 * Every `fs` event carries `id: <epoch>.<position>`, and so does each ping:
 * the position up to which this stream has sent everything the login sees.
 * A browser that reconnects with that id (`Last-Event-ID`, or the
 * `lastEventId` query parameter) first gets every event it missed. When
 * those rows are gone (the journal dropped them, the database was restored
 * under a new epoch, or they cannot be read) it gets one `resync` instead
 * and refetches what it shows. Without an id the stream starts now.
 */
export function registerEventRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: EventRoutesDeps,
): void {
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const path = ROUTES.events.slice(API_PREFIX.length);

  groups.authed.get(path, (c) => {
    const principal = c.get("principal");
    const signal = c.req.raw.signal;
    const resume = c.req.header("last-event-id") ?? c.req.query("lastEventId");

    const response = streamSSE(c, async (stream) => {
      const epoch = deps.journal.epoch();
      const id = (position: number) => `${epoch}.${position}`;
      const at = () => deps.clock().toISOString();
      /** Everything this login sees up to this position has been sent. */
      let sent = 0;
      let live = false;
      const held: BusEvent[] = [];

      const write = (event: SseEvent, position: number) => {
        sent = position;
        void stream.writeSSE({ event: event.type, id: id(position), data: JSON.stringify(event) });
      };
      const send = (event: BusEvent) => {
        if (event.type !== "fs") {
          void stream.writeSSE({ event: event.type, data: JSON.stringify(toWireEvent(event)) });
        } else if (event.position > sent) {
          write(toWireEvent(event), event.position);
        }
      };
      const ping = () => {
        // Live, every row up to the reader's position has reached this stream.
        sent = Math.max(sent, deps.journal.position());
        void stream.writeSSE({
          event: "ping",
          id: id(sent),
          data: JSON.stringify({ type: "ping", at: at() }),
        });
      };

      // Subscribed and split in one tick: rows up to `upTo` are replayed, later
      // ones arrive through the bus and wait in `held` until the replay is done.
      const unsubscribe = deps.bus.subscribe({ identityId: principal.identityId }, (event) => {
        if (live) send(event);
        else held.push(event);
      });
      const upTo = deps.journal.position();

      let timer: ReturnType<typeof setInterval> | undefined;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        unsubscribe();
        clearInterval(timer);
      };
      stream.onAbort(cleanup);

      const from = resumeFrom(resume, epoch);
      const replayed =
        typeof from === "number" && from < upTo
          ? await deps.journal.replay(principal.username, from, upTo, write)
          : true;
      if (from === "other" || !replayed) write({ type: "resync", at: at() }, upTo);
      else sent = Math.max(from ?? upTo, upTo);
      live = true;
      for (const event of held.splice(0)) send(event);
      ping();
      timer = setInterval(ping, pingIntervalMs);

      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          cleanup();
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            cleanup();
            resolve();
          },
          { once: true },
        );
      });
    });

    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Accel-Buffering", "no");
    return response;
  });
}
