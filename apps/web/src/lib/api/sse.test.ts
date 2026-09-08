// @vitest-environment jsdom
import type { FsEvent, JobEvent, JobStatus, PingEvent } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountTransition } from "../account/transition";
import {
  applyJobEvent,
  invalidateForEvent,
  type JobsStoreLike,
  keysToInvalidate,
  nextBackoffMs,
  parseSseMessage,
  useFsEvents,
} from "./sse.ts";

function fsEvent(overrides: Partial<FsEvent> = {}): FsEvent {
  return {
    type: "fs",
    op: "update",
    identityId: "00000000-0000-0000-0000-000000000000",
    paths: ["/a/b.txt"],
    at: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

const PING_EVENT: PingEvent = { type: "ping", at: "2026-09-06T00:00:00.000Z" };

function job(overrides: Partial<JobStatus> & Pick<JobStatus, "id" | "state">): JobStatus {
  return {
    kind: "compress",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    progress: { processed: 0, total: null, bytes: 0 },
    ...overrides,
  };
}

function jobEvent(overrides: Partial<JobStatus> & Pick<JobStatus, "id" | "state">): JobEvent {
  return { type: "job", job: job(overrides), at: "2026-09-06T00:00:00.000Z" };
}

function fakeJobsStore(): JobsStoreLike & { upserted: JobStatus[] } {
  const upserted: JobStatus[] = [];
  return {
    upserted,
    upsert(j: JobStatus) {
      upserted.push(j);
    },
  };
}

describe("keysToInvalidate", () => {
  it("invalidates nothing for a ping event", () => {
    expect(keysToInvalidate(PING_EVENT)).toEqual([]);
  });

  it("invalidates the parent directory of every affected path, and the trash list", () => {
    expect(keysToInvalidate(fsEvent({ paths: ["/a/b.txt"] }))).toEqual([
      ["fs", "list", "/a"],
      ["trash", "list"],
      ["fs", "archiveEntries", "/a/b.txt"],
    ]);
  });

  it("also invalidates the parent of every target path", () => {
    const event = fsEvent({ op: "copy", paths: ["/a/b.txt"], targetPaths: ["/c/d.txt"] });
    expect(keysToInvalidate(event)).toEqual([
      ["fs", "list", "/a"],
      ["fs", "list", "/c"],
      ["trash", "list"],
      ["fs", "archiveEntries", "/a/b.txt"],
      ["fs", "archiveEntries", "/c/d.txt"],
    ]);
  });

  it("also invalidates favorites, recents, and tag files for a move or delete (metadataKeysToInvalidate)", () => {
    const moveEvent = fsEvent({ op: "move", paths: ["/a/b.txt"], targetPaths: ["/c/d.txt"] });
    expect(keysToInvalidate(moveEvent)).toEqual([
      ["fs", "list", "/a"],
      ["fs", "list", "/c"],
      ["favorites", "list"],
      ["recents", "list"],
      ["tags", "files"],
      ["folder-views"],
      ["trash", "list"],
      ["fs", "archiveEntries", "/a/b.txt"],
      ["fs", "archiveEntries", "/c/d.txt"],
    ]);

    const deleteEvent = fsEvent({ op: "delete", paths: ["/a/b.txt"] });
    expect(keysToInvalidate(deleteEvent)).toEqual([
      ["fs", "list", "/a"],
      ["favorites", "list"],
      ["recents", "list"],
      ["tags", "files"],
      ["folder-views"],
      ["trash", "list"],
      ["fs", "archiveEntries", "/a/b.txt"],
    ]);
  });

  it("deduplicates parents shared by multiple paths", () => {
    const event = fsEvent({ paths: ["/a/b.txt", "/a/c.txt"] });
    expect(keysToInvalidate(event)).toEqual([
      ["fs", "list", "/a"],
      ["trash", "list"],
      ["fs", "archiveEntries", "/a/b.txt"],
      ["fs", "archiveEntries", "/a/c.txt"],
    ]);
  });

  it("invalidates nothing for a job event that has not reached done", () => {
    expect(keysToInvalidate(jobEvent({ id: "1", state: "running" }))).toEqual([]);
  });

  it("invalidates nothing for a done job with no result (should not happen, defensive)", () => {
    expect(keysToInvalidate(jobEvent({ id: "1", state: "done" }))).toEqual([]);
  });

  it("invalidates the result path's parent and the result path itself for a done job", () => {
    const event = jobEvent({ id: "1", state: "done", result: { path: "/a/docs.zip" } });
    expect(keysToInvalidate(event)).toEqual([
      ["fs", "list", "/a"],
      ["fs", "list", "/a/docs.zip"],
    ]);
  });
});

describe("applyJobEvent", () => {
  it("upserts the job for a job event", () => {
    const store = fakeJobsStore();
    const event = jobEvent({ id: "1", state: "running" });

    applyJobEvent(store, event);

    expect(store.upserted).toEqual([event.job]);
  });

  it("does nothing for a non-job event", () => {
    const store = fakeJobsStore();

    applyJobEvent(store, PING_EVENT);
    applyJobEvent(store, fsEvent());

    expect(store.upserted).toEqual([]);
  });
});

describe("nextBackoffMs", () => {
  it("starts at the initial delay when there was no prior attempt", () => {
    expect(nextBackoffMs(undefined)).toBe(1000);
  });

  it("doubles the previous delay", () => {
    expect(nextBackoffMs(1000)).toBe(2000);
    expect(nextBackoffMs(2000)).toBe(4000);
  });

  it("caps the delay at 30 seconds", () => {
    expect(nextBackoffMs(20_000)).toBe(30_000);
    expect(nextBackoffMs(30_000)).toBe(30_000);
  });
});

describe("parseSseMessage", () => {
  it("parses a valid fs event", () => {
    const event = fsEvent();
    expect(parseSseMessage(JSON.stringify(event))).toEqual(event);
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseSseMessage("{not json")).toBeUndefined();
  });

  it("returns undefined for JSON that doesn't match the schema", () => {
    expect(parseSseMessage(JSON.stringify({ type: "nope" }))).toBeUndefined();
  });
});

describe("invalidateForEvent", () => {
  it("invalidates every key from keysToInvalidate", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    invalidateForEvent(queryClient, fsEvent({ paths: ["/a/b.txt"] }));

    expect(spy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
  });

  it("invalidates nothing for a ping event", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    invalidateForEvent(queryClient, PING_EVENT);

    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * Stands in for the real `EventSource`, matching how the API actually sends
 * events: each one carries an explicit `event:` field equal to its own
 * `type` (see `apps/api/src/events/routes.ts`), so `emitMessage` dispatches
 * to listeners registered under that same name via `addEventListener`,
 * exactly as `useFsEvents` itself registers them, rather than the simpler
 * (but not what the API sends) unnamed default `onmessage` event.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<(ev: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(data: { type: string }): void {
    const message = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(data.type) ?? []) {
      listener(message);
    }
  }

  emitError(): void {
    this.onerror?.();
  }
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useFsEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes synchronously before account mutation and ignores late events/reconnects", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const store = fakeJobsStore();
    const { unmount } = renderHook(() => useFsEvents(store), { wrapper: createWrapper(client) });
    const source = FakeEventSource.instances[0];
    source?.emitError();
    accountTransition.begin();
    expect(source?.closed).toBe(true);
    source?.emitMessage(fsEvent());
    source?.emitMessage(jobEvent({ id: "late", state: "done" }));
    source?.emitError();
    vi.advanceTimersByTime(30_000);
    expect(invalidate).not.toHaveBeenCalled();
    expect(store.upserted).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(1);
    accountTransition.finish(false);
    unmount();
  });
  it("opens exactly one EventSource to ROUTES.events on mount", () => {
    const queryClient = new QueryClient();
    renderHook(() => useFsEvents(), { wrapper: createWrapper(queryClient) });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/v1/events");
  });

  it("invalidates the affected fs list query on a valid message", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useFsEvents(), { wrapper: createWrapper(queryClient) });

    FakeEventSource.instances[0]?.emitMessage(fsEvent({ paths: ["/a/b.txt"] }));

    expect(spy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
  });

  it("ignores a message that fails schema validation", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useFsEvents(), { wrapper: createWrapper(queryClient) });

    // Sent under the real "fs" event name (as the API would), but missing
    // the fields `FsEvent` requires, so it reaches the handler and fails
    // `parseSseMessage`'s schema check rather than never being delivered.
    FakeEventSource.instances[0]?.emitMessage({ type: "fs" });

    expect(spy).not.toHaveBeenCalled();
  });

  it("feeds a job event into the jobs store", () => {
    const queryClient = new QueryClient();
    const store = fakeJobsStore();
    renderHook(() => useFsEvents(store), { wrapper: createWrapper(queryClient) });

    FakeEventSource.instances[0]?.emitMessage(jobEvent({ id: "1", state: "running" }));

    expect(store.upserted).toHaveLength(1);
    expect(store.upserted[0]?.id).toBe("1");
  });

  it("invalidates both the result path's parent and the result path for a done job", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useFsEvents(fakeJobsStore()), { wrapper: createWrapper(queryClient) });

    FakeEventSource.instances[0]?.emitMessage(
      jobEvent({ id: "1", state: "done", result: { path: "/a/docs.zip" } }),
    );

    expect(spy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a/docs.zip"] });
  });

  it("reconnects with backoff after an error, and closes the failed connection", () => {
    const queryClient = new QueryClient();
    renderHook(() => useFsEvents(), { wrapper: createWrapper(queryClient) });

    const first = FakeEventSource.instances[0] as FakeEventSource;
    first.emitError();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("closes the connection and cancels a pending reconnect on unmount", () => {
    const queryClient = new QueryClient();
    const { unmount } = renderHook(() => useFsEvents(), { wrapper: createWrapper(queryClient) });

    const first = FakeEventSource.instances[0] as FakeEventSource;
    first.emitError();
    unmount();

    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.closed).toBe(true);
  });

  it("ignores an error that fires after unmount", () => {
    const queryClient = new QueryClient();
    const { unmount } = renderHook(() => useFsEvents(), { wrapper: createWrapper(queryClient) });

    const first = FakeEventSource.instances[0] as FakeEventSource;
    unmount();
    first.emitError();

    vi.advanceTimersByTime(30_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

it("invalidates cached archive listings for every path an fs event names", async () => {
  const { keysToInvalidate } = await import("./sse");
  const keys = keysToInvalidate({
    type: "fs",
    op: "move",
    identityId: "id",
    paths: ["/a.zip"],
    targetPaths: ["/b.zip"],
    at: "2026-01-01T00:00:00.000Z",
  });
  expect(keys).toContainEqual(["fs", "archiveEntries", "/a.zip"]);
  expect(keys).toContainEqual(["fs", "archiveEntries", "/b.zip"]);
});
