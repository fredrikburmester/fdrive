"use client";

import { type JobStatus, SseEvent } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import {
  hashKey,
  type InvalidateQueryFilters,
  type QueryClient,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { accountTransition } from "../account/transition";
import { archiveKeysToInvalidate } from "../archive/invalidation";
import { useJobsStore } from "../jobs/store";
import { metadataKeysToInvalidate } from "../metadata/invalidation";
import { trashKeysToInvalidate } from "../trash/invalidation";
import { tabEventsUrl } from "./client";
import { queryKeys } from "./keys";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** How long invalidation waits for more events in the same burst. */
export const INVALIDATION_QUIET_MS = 250;
/** The longest a steady stream of events can hold invalidation back. */
export const INVALIDATION_MAX_WAIT_MS = 1000;

/**
 * The SSE event names the API sends (one per `SseEvent` variant's own
 * `type`, see `apps/api/src/events/routes.ts`'s `toWireEvent`). `EventSource`
 * only invokes listeners registered for the exact event name it was sent
 * under, so `useFsEvents` registers one listener per entry here rather than
 * relying on `onmessage`, which only fires for the unnamed default event.
 */
const SSE_EVENT_TYPES = ["fs", "job", "ping"] as const;

/**
 * Pure mapping from an incoming SSE event to the fs list query keys that
 * should be invalidated. Ping events invalidate nothing. `fs` events
 * invalidate the parent directory listing of every affected path, plus of
 * every `targetPaths` entry (present for `move` and `copy`), deduplicated.
 * `job` events invalidate nothing until the job reaches `done`, at which
 * point they invalidate both the result path's parent (so the new archive
 * or extracted folder shows up in its listing) and the result path itself
 * (so an already-open listing of an extraction's destination folder picks
 * up its new contents).
 */
export function keysToInvalidate(event: SseEvent): QueryKey[] {
  if (event.type === "ping") {
    return [];
  }

  if (event.type === "job") {
    if (event.job.state !== "done" || event.job.result === undefined) {
      return [];
    }
    const resultPath = event.job.result.path;
    return [
      queryKeys.fs.list(parentPath(resultPath)),
      queryKeys.fs.list(resultPath),
      ["fs", "stat"],
      ["fs", "folder-size"],
    ];
  }

  const parents = new Set<string>();
  for (const path of event.paths) {
    parents.add(parentPath(path));
  }
  for (const path of event.targetPaths ?? []) {
    parents.add(parentPath(path));
  }

  return [
    ...[...parents].map((parent) => queryKeys.fs.list(parent)),
    // Directory moves/deletes and extraction affect descendants; sizes affect every ancestor.
    ["fs", "stat"],
    ["fs", "folder-size"],
    ...metadataKeysToInvalidate(event),
    ...(event.op === "move" || event.op === "delete" ? [queryKeys.folderViews.all()] : []),
    ...trashKeysToInvalidate(event),
    ...archiveKeysToInvalidate(event),
  ];
}

/** The slice of the jobs store `useFsEvents` needs to apply a `job` event. */
export interface JobsStoreLike {
  upsert(job: JobStatus): void;
}

/** Feeds a `job` event's `JobStatus` into the jobs store; a no-op for any other event type. */
export function applyJobEvent(jobsStore: JobsStoreLike, event: SseEvent): void {
  if (event.type === "job") {
    jobsStore.upsert(event.job);
  }
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

export interface InvalidationBatch {
  add(keys: readonly QueryKey[]): void;
  dispose(): void;
}

/**
 * Applies the invalidations from a burst of events once per distinct key. An upload or
 * an indexer scan sends one event per file, and invalidating on each one refetched the
 * open listing and every stat and folder size that many times. Flushes wait for
 * `INVALIDATION_QUIET_MS` of quiet, but never longer than `INVALIDATION_MAX_WAIT_MS`.
 *
 * A query that is already fetching is left to finish rather than cancelled: restarting
 * it on every flush would starve a slow listing under a steady stream, and the server
 * keeps doing the abandoned work anyway. Its response may predate the change, so it is
 * invalidated again once that fetch settles.
 */
export function createInvalidationBatch(queryClient: QueryClient): InvalidationBatch {
  const pending = new Map<string, InvalidateQueryFilters>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstQueuedAt: number | undefined;

  function schedule(): void {
    const now = Date.now();
    firstQueuedAt ??= now;
    if (timer !== undefined) clearTimeout(timer);
    const delay = Math.min(INVALIDATION_QUIET_MS, firstQueuedAt + INVALIDATION_MAX_WAIT_MS - now);
    timer = setTimeout(flush, Math.max(0, delay));
  }

  function flush(): void {
    timer = undefined;
    firstQueuedAt = undefined;
    const filters = [...pending.values()];
    pending.clear();
    for (const filter of filters) {
      for (const query of queryClient.getQueryCache().findAll(filter)) {
        if (query.state.fetchStatus === "fetching") {
          pending.set(query.queryHash, { queryKey: query.queryKey, exact: true });
        }
      }
      void queryClient.invalidateQueries(filter, { cancelRefetch: false });
    }
    if (pending.size > 0) schedule();
  }

  return {
    add(keys) {
      if (keys.length === 0) return;
      for (const queryKey of keys) pending.set(hashKey(queryKey), { queryKey });
      schedule();
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      firstQueuedAt = undefined;
      pending.clear();
    },
  };
}

/**
 * Opens a single `EventSource` to `ROUTES.events` for the lifetime of the
 * mounted component, parsing each message as an `SseEvent`, invalidating
 * the fs list queries it affects in batches, and feeding `job` events into the jobs
 * store (defaulting to the app-wide `useJobsStore`; overridable so tests
 * never need to touch that global singleton). Reconnects with exponential
 * backoff (`nextBackoffMs`) on error, and closes the connection on unmount.
 */
export function useFsEvents(jobsStore: JobsStoreLike = useJobsStore.getState()): void {
  const queryClient = useQueryClient();
  const backoffRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const invalidations = createInvalidationBatch(queryClient);
    const unsubscribe = accountTransition.subscribe(() => {
      if (accountTransition.getSnapshot().pending) {
        cancelled = true;
        source?.close();
        invalidations.dispose();
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      }
    });

    function connect(): void {
      source = new EventSource(tabEventsUrl());

      function handleMessage(message: MessageEvent<string>): void {
        if (cancelled) return;
        const event = parseSseMessage(message.data);
        if (event === undefined) {
          return;
        }
        backoffRef.current = undefined;
        invalidations.add(keysToInvalidate(event));
        applyJobEvent(jobsStore, event);
      }

      // The API sends each event with an explicit `event:` field matching
      // its own `type` ("fs", "job", "ping"; see `apps/api/src/events/routes.ts`),
      // never the SSE default ("message"), so a plain `onmessage` handler
      // never fires. `SSE_EVENT_TYPES` is exactly that set of names.
      for (const type of SSE_EVENT_TYPES) {
        source.addEventListener(type, handleMessage);
      }

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
      unsubscribe();
      invalidations.dispose();
      source?.close();
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [queryClient, jobsStore]);
}
