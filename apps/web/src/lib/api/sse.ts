"use client";

import { ROUTES, SseEvent } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { queryKeys } from "./keys";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Pure mapping from an incoming SSE event to the fs list query keys that
 * should be invalidated. Ping events invalidate nothing. `fs` events
 * invalidate the parent directory listing of every affected path, plus of
 * every `targetPaths` entry (present for `move` and `copy`), deduplicated.
 */
export function keysToInvalidate(event: SseEvent): QueryKey[] {
  if (event.type !== "fs") {
    return [];
  }

  const parents = new Set<string>();
  for (const path of event.paths) {
    parents.add(parentPath(path));
  }
  for (const path of event.targetPaths ?? []) {
    parents.add(parentPath(path));
  }

  return [...parents].map((parent) => queryKeys.fs.list(parent));
}

/**
 * Computes the next reconnect delay for the SSE connection: doubling from
 * `INITIAL_BACKOFF_MS`, capped at `MAX_BACKOFF_MS`. Pass `undefined` (no
 * prior failed attempt) to get the initial delay.
 */
export function nextBackoffMs(previousMs: number | undefined): number {
  if (previousMs === undefined) {
    return INITIAL_BACKOFF_MS;
  }
  return Math.min(previousMs * 2, MAX_BACKOFF_MS);
}

/**
 * Parses one SSE message's `data` payload into an `SseEvent`, returning
 * `undefined` when it is not valid JSON or does not match the schema.
 */
export function parseSseMessage(data: string): SseEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  const result = SseEvent.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Invalidates every query key affected by `event`, via `keysToInvalidate`. */
export function invalidateForEvent(queryClient: QueryClient, event: SseEvent): void {
  for (const key of keysToInvalidate(event)) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/**
 * Opens a single `EventSource` to `ROUTES.events` for the lifetime of the
 * mounted component, parsing each message as an `SseEvent` and invalidating
 * the fs list queries it affects. Reconnects with exponential backoff
 * (`nextBackoffMs`) on error, and closes the connection on unmount.
 */
export function useFsEvents(): void {
  const queryClient = useQueryClient();
  const backoffRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    function connect(): void {
      source = new EventSource(ROUTES.events);

      source.onmessage = (message: MessageEvent<string>) => {
        const event = parseSseMessage(message.data);
        if (event === undefined) {
          return;
        }
        backoffRef.current = undefined;
        invalidateForEvent(queryClient, event);
      };

      source.onerror = () => {
        source?.close();
        if (cancelled) {
          return;
        }
        const delay = nextBackoffMs(backoffRef.current);
        backoffRef.current = delay;
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      source?.close();
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [queryClient]);
}
