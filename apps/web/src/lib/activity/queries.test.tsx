// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/keys";
import { activityGesture, useActivityGesture } from "./gestures";
import { useActivityFile, useActivityHistory, useActivityLocations } from "./queries";

const mocks = vi.hoisted(() => ({
  me: undefined as { account: { id: string } } | undefined,
  identity: undefined as string | undefined,
  feed: vi.fn(),
  file: vi.fn(),
  locations: vi.fn(),
  request: vi.fn(),
}));
vi.mock("@/lib/api/auth-queries", () => ({ useMe: () => ({ data: mocks.me }) }));
vi.mock("@/lib/api/client", () => ({ getTabIdentity: () => mocks.identity }));
vi.mock("./api", () => ({
  activityFeed: mocks.feed,
  activityFile: mocks.file,
  activityLocations: mocks.locations,
  activityRequest: mocks.request,
}));
const streams: FakeStream[] = [];
class FakeStream extends EventTarget {
  close = vi.fn();
  constructor(readonly url: string) {
    super();
    streams.push(this);
  }
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  };
}
beforeEach(() => {
  mocks.me = undefined;
  mocks.identity = undefined;
  streams.length = 0;
  vi.clearAllMocks();
  mocks.request.mockResolvedValue({});
  vi.stubGlobal("EventSource", FakeStream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("captures the initiating login and reuses a gesture receipt across retries", async () => {
  await activityGesture("file.open", "/a")();
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.identity = "original";
  const send = activityGesture("share.copy_link", "/a", "share");
  mocks.identity = "replacement";
  await send();
  await send();
  const first = mocks.request.mock.calls[0]?.[1];
  expect(JSON.parse(first.body)).toMatchObject({
    identityId: "original",
    path: "/a",
    action: "share.copy_link",
    shareId: "share",
  });
  expect(mocks.request.mock.calls[1]?.[1]).toEqual(first);
  const hook = renderHook(({ path }) => useActivityGesture("file.inspect", path), {
    initialProps: { path: undefined as string | undefined },
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  hook.rerender({ path: "/b" });
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3));
  hook.rerender({ path: "/b" });
  expect(mocks.request).toHaveBeenCalledTimes(3);
  mocks.request.mockRejectedValueOnce(Error("offline"));
  hook.rerender({ path: "/c" });
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(4));
  mocks.identity = "another-storage";
  hook.rerender({ path: "/c" });
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(5));
  expect(JSON.parse(mocks.request.mock.calls[4]?.[1].body)).toMatchObject({
    identityId: "another-storage",
    path: "/c",
  });
  hook.unmount();
});

it("keeps account caches separate, pages the selected scope and closes stale live streams", async () => {
  const { wrapper, client } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  mocks.feed.mockResolvedValue({ items: [], nextCursor: "page-two" });
  const hook = renderHook(() => useActivityHistory({ action: "file.move" }, "/files/id/events"), {
    wrapper,
  });
  expect(hook.result.current.fetchStatus).toBe("idle");
  expect(streams).toHaveLength(0);
  mocks.me = { account: { id: "alice" } };
  hook.rerender();
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(mocks.feed).toHaveBeenLastCalledWith({ action: "file.move" }, "/files/id/events");
  mocks.feed.mockResolvedValueOnce({ items: [], nextCursor: null });
  await act(() => hook.result.current.fetchNextPage());
  expect(mocks.feed).toHaveBeenLastCalledWith(
    { action: "file.move", cursor: "page-two" },
    "/files/id/events",
  );
  await waitFor(() => expect(hook.result.current.hasNextPage).toBe(false));
  streams[0]?.dispatchEvent(new Event("activity"));
  streams[0]?.dispatchEvent(new Event("activity"));
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  expect(invalidate).toHaveBeenLastCalledWith({ queryKey: queryKeys.activity.all("alice") });
  mocks.me = { account: { id: "bob" } };
  hook.rerender();
  expect(streams[0]?.close).toHaveBeenCalledOnce();
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(
    client.getQueryData(
      queryKeys.activity.feed("alice", { action: "file.move" }, "/files/id/events"),
    ),
  ).toBeDefined();
  streams[1]?.dispatchEvent(new Event("activity"));
  hook.unmount();
  expect(streams[1]?.close).toHaveBeenCalledOnce();
  client.clear();
});

it("loads journey locations only when signed in and uses the same owner namespace", async () => {
  const { wrapper, client } = setup();
  mocks.file.mockResolvedValue({ id: "file" });
  mocks.locations.mockResolvedValue([]);
  const hook = renderHook(
    () => ({
      file: useActivityFile("file"),
      locations: useActivityLocations(),
      feed: useActivityHistory({}),
    }),
    { wrapper },
  );
  expect(hook.result.current.file.fetchStatus).toBe("idle");
  expect(hook.result.current.locations.fetchStatus).toBe("idle");
  mocks.me = { account: { id: "alice" } };
  mocks.feed.mockResolvedValue({ items: [], nextCursor: null });
  hook.rerender();
  await waitFor(() =>
    expect(hook.result.current.file.isSuccess && hook.result.current.locations.isSuccess).toBe(
      true,
    ),
  );
  expect(mocks.file).toHaveBeenCalledWith("file");
  expect(mocks.locations).toHaveBeenCalled();
  expect(client.getQueryData(queryKeys.activity.file("alice", "file"))).toEqual({ id: "file" });
  hook.unmount();
  client.clear();
});
