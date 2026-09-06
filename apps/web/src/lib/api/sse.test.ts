// @vitest-environment jsdom
import type { FsEvent, PingEvent } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateForEvent,
  keysToInvalidate,
  nextBackoffMs,
  parseSseMessage,
  useFsEvents,
} from "./sse.js";

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

describe("keysToInvalidate", () => {
  it("invalidates nothing for a ping event", () => {
    expect(keysToInvalidate(PING_EVENT)).toEqual([]);
  });

  it("invalidates the parent directory of every affected path", () => {
    expect(keysToInvalidate(fsEvent({ paths: ["/a/b.txt"] }))).toEqual([["fs", "list", "/a"]]);
  });

  it("also invalidates the parent of every target path", () => {
    const event = fsEvent({ op: "move", paths: ["/a/b.txt"], targetPaths: ["/c/d.txt"] });
    expect(keysToInvalidate(event)).toEqual([
      ["fs", "list", "/a"],
      ["fs", "list", "/c"],
    ]);
  });

  it("deduplicates parents shared by multiple paths", () => {
    const event = fsEvent({ paths: ["/a/b.txt", "/a/c.txt"] });
    expect(keysToInvalidate(event)).toEqual([["fs", "list", "/a"]]);
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

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
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

    FakeEventSource.instances[0]?.emitMessage({ type: "nope" });

    expect(spy).not.toHaveBeenCalled();
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
