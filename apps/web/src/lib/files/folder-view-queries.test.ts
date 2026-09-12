// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountTransition } from "@/lib/account/transition";
import { queryKeys } from "@/lib/api/keys";
import { useFolderView, useResetFolderViews } from "./folder-view-queries";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  reset: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {},
  pinTabIdentity: vi.fn(),
  snapshotTabApiClient: () => ({
    getFolderView: mocks.get,
    setFolderView: mocks.set,
    removeFolderView: mocks.remove,
    resetFolderViews: mocks.reset,
  }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: mocks.success } }));
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.get.mockResolvedValue({ view: null });
  mocks.set.mockResolvedValue({ ok: true });
  mocks.remove.mockResolvedValue({ ok: true });
  mocks.reset.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  client.clear();
  accountTransition.finish(true);
});

describe("folder view query", () => {
  it("pins immediately, leaves global alone, and does not leak into a sibling during navigation", async () => {
    let complete!: () => void;
    mocks.set.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ path }) => useFolderView(path, "alice"), {
      wrapper,
      initialProps: { path: "/photos" },
    });
    await waitFor(() => expect(result.current.disabled).toBe(false));
    act(() => result.current.setMode("grid"));
    await waitFor(() => expect(result.current.mode).toBe("grid"));
    expect(localStorage.getItem("fdrive.view")).toBeNull();
    act(() => result.current.setMode("tree"));
    expect(mocks.set).toHaveBeenCalledTimes(1);
    rerender({ path: "/other" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.mode).toBe("list");
    await act(async () => complete());
    await waitFor(() => expect(result.current.disabled).toBe(false));
    expect(mocks.set).toHaveBeenCalledWith({ path: "/photos", mode: "grid" });
  });
  it("uses an exact server pin, makes it the default, and unpins explicitly", async () => {
    mocks.get.mockResolvedValue({ view: { path: "/photos", mode: "tree" } });
    const { result } = renderHook(() => useFolderView("/photos", "alice"), { wrapper });
    await waitFor(() => expect(result.current.pinned).toBe(true));
    expect(result.current.mode).toBe("tree");
    act(() => result.current.makeDefault());
    expect(localStorage.getItem("fdrive.view")).toBe('"tree"');
    mocks.get.mockResolvedValue({ view: null });
    act(() => result.current.useDefault());
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ path: "/photos" }));
    await waitFor(() => expect(result.current.pinned).toBe(false));
    expect(result.current.mode).toBe("tree");
  });
  it("rolls back a failed save and supports retrying a failed load", async () => {
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useFolderView("/photos", "alice"), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(true));
    act(() => result.current.setMode("grid"));
    expect(mocks.set).not.toHaveBeenCalled();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.disabled).toBe(false));
    mocks.set.mockRejectedValue(new Error("offline"));
    act(() => result.current.setMode("grid"));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    await waitFor(() => expect(result.current.disabled).toBe(false));
    expect(result.current.mode).toBe("list");
  });
  it("does not fetch without an identity or mutate during an account change", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useFolderView("/", id),
      { wrapper, initialProps: { id: undefined as string | undefined } },
    );
    expect(mocks.get).not.toHaveBeenCalled();
    rerender({ id: "alice" });
    await waitFor(() => expect(result.current.disabled).toBe(false));
    accountTransition.begin();
    act(() => result.current.setMode("grid"));
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("ignores late failed writes after an identity switch", async () => {
    let fail!: (error: Error) => void;
    mocks.set.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { result } = renderHook(() => useFolderView("/photos", "alice"), { wrapper });
    await waitFor(() => expect(result.current.disabled).toBe(false));
    act(() => result.current.setMode("grid"));
    await waitFor(() => expect(mocks.set).toHaveBeenCalled());
    accountTransition.finish(true);
    client.setQueryData(queryKeys.folderViews.path("bob", "/photos"), {
      view: { path: "/photos", mode: "tree" },
    });
    await act(async () => fail(new Error("late failure")));
    expect(mocks.error).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.folderViews.path("bob", "/photos"))).toEqual({
      view: { path: "/photos", mode: "tree" },
    });
  });
});

it("resets saved pins and invalidates every identity's view cache", async () => {
  client.setQueryData(queryKeys.folderViews.path("alice", "/"), {
    view: { path: "/", mode: "grid" },
  });
  const { result } = renderHook(useResetFolderViews, { wrapper });
  await act(async () => result.current.mutateAsync());
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(client.getQueryState(queryKeys.folderViews.path("alice", "/"))?.isInvalidated).toBe(true);
  expect(mocks.success).toHaveBeenCalled();
});

it("reports reset errors and refuses reset from an old login", async () => {
  mocks.reset.mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(useResetFolderViews, { wrapper });
  await act(async () => {
    await expect(result.current.mutateAsync()).rejects.toThrow("offline");
  });
  expect(mocks.error).toHaveBeenCalled();
  accountTransition.finish(true);
  await act(async () => {
    await expect(result.current.mutateAsync()).rejects.toThrow("Login changed");
  });
  expect(mocks.reset).toHaveBeenCalledOnce();
});

it("allows saving another folder while the first folder is still saving", async () => {
  const first = Promise.withResolvers<void>();
  mocks.set.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true });
  const { result, rerender } = renderHook(({ path }) => useFolderView(path, "alice"), {
    wrapper,
    initialProps: { path: "/first" },
  });
  await waitFor(() => expect(result.current.disabled).toBe(false));
  act(() => result.current.setMode("grid"));
  await waitFor(() => expect(mocks.set).toHaveBeenCalledTimes(1));
  rerender({ path: "/second" });
  await waitFor(() => expect(result.current.disabled).toBe(false));
  act(() => result.current.setMode("tree"));
  await waitFor(() => expect(mocks.set).toHaveBeenCalledTimes(2));
  expect(mocks.set).toHaveBeenLastCalledWith({ path: "/second", mode: "tree" });
  await act(async () => first.resolve());
});
