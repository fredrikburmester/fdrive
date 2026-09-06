import { ROUTES, type SseEvent } from "@fdrive/contracts";
import { streamSSE } from "hono/streaming";
import type { AppHono, AuthedHono } from "../app.js";
import type { BusEvent, EventBus } from "./bus.js";

const API_PREFIX = "/api/v1";
const DEFAULT_PING_INTERVAL_MS = 25_000;

export interface EventRoutesDeps {
  readonly bus: EventBus;
  readonly clock: () => Date;
  readonly pingIntervalMs?: number;
}

function pingEvent(clock: () => Date): SseEvent {
  return { type: "ping", at: clock().toISOString() };
}

/**
 * Converts a `BusEvent` into the wire `SseEvent` shape: an `FsEvent` is
 * already wire-shaped, while a job event's bus-only `identityId` (used to
 * route it to the right subscriber) is stripped, since the wire `JobEvent`
 * has no such field.
 */
function toWireEvent(event: BusEvent): SseEvent {
  if (event.type === "fs") {
    return event;
  }
  const { identityId: _identityId, ...jobEvent } = event;
  return jobEvent;
}

/**
 * Registers `GET /events`: a Server-Sent Events stream of the caller's
 * identity's `FsEvent`s, published by `deps.bus`. Sends a `ping` message
 * immediately (so a client can confirm the connection opened), forwards
 * every matching `fs` event as it is published, and pings again every
 * `pingIntervalMs` (default 25s) so intermediate proxies do not time the
 * connection out. Unsubscribes from the bus as soon as the request is
 * aborted.
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

    const response = streamSSE(c, async (stream) => {
      const unsubscribe = deps.bus.subscribe({ identityId: principal.identityId }, (event) => {
        const wireEvent = toWireEvent(event);
        void stream.writeSSE({ event: wireEvent.type, data: JSON.stringify(wireEvent) });
      });

      // Registered before the timer exists so an abort that races the very
      // first tick still unsubscribes; `cleanup` closes over `timer` and
      // only ever runs after it has been assigned below.
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        unsubscribe();
        clearInterval(timer);
      };
      stream.onAbort(cleanup);

      const timer = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: JSON.stringify(pingEvent(deps.clock)) });
      }, pingIntervalMs);

      await stream.writeSSE({ event: "ping", data: JSON.stringify(pingEvent(deps.clock)) });

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
