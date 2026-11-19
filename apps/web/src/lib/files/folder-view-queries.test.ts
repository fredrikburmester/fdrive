// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  apiClient: {
    getFolderView: (...args: unknown[]) => mocks.get(...args),
    setFolderView: (...args: unknown[]) => mocks.set(...args),
    removeFolderView: (...args: unknown[]) => mocks.remove(...args),
    resetFolderViews: (...args: unknown[]) => mocks.reset(...args),
  },
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
    const { result, rerender } = renderHook(({ path }) => useFolderView(path), {
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
    expect(result.current.mode).toBe("tree");
    await act(async () => complete());
    await waitFor(() => expect(result.current.disabled).toBe(false));
    expect(mocks.set).toHaveBeenCalledWith({ path: "/photos", mode: "grid" });
  });
  it("uses an exact server pin, makes it the default, and unpins explicitly", async () => {
    mocks.get.mockResolvedValue({ view: { path: "/photos", mode: "list" } });
    const { result } = renderHook(() => useFolderView("/photos"), { wrapper });
    await waitFor(() => expect(result.current.pinned).toBe(true));
    expect(result.current.mode).toBe("list");
    act(() => result.current.makeDefault());
    expect(localStorage.getItem("fdrive.view")).toBe('"list"');
    mocks.get.mockResolvedValue({ view: null });
    act(() => result.current.useDefault());
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith({ path: "/photos", part: "mode" }),
    );
    await waitFor(() => expect(result.current.pinned).toBe(false));
    expect(result.current.mode).toBe("list");
  });
  it("rolls back a failed save and supports retrying a failed load", async () => {
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useFolderView("/photos"), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(true));
    act(() => result.current.setMode("grid"));
    expect(mocks.set).not.toHaveBeenCalled();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.disabled).toBe(false));
    mocks.set.mockRejectedValue(new Error("offline"));
    act(() => result.current.setMode("grid"));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    await waitFor(() => expect(result.current.disabled).toBe(false));
    expect(result.current.mode).toBe("tree");
  });
});

describe("folder sort", () => {
  const bySize = { key: "size", direction: "desc" } as const;
  it("follows the browser default until a sort is pinned, then pins only the sort", async () => {
    localStorage.setItem("fdrive.sort", JSON.stringify({ key: "ext", direction: "asc" }));
    const { result } = renderHook(() => useFolderView("/photos"), { wrapper });
    await waitFor(() => expect(result.current.disabled).toBe(false));
    expect(result.current.sort).toEqual({ key: "ext", direction: "asc" });
    expect(result.current.sortPinned).toBe(false);
    mocks.get.mockResolvedValue({ view: { path: "/photos", mode: null, sort: bySize } });
    act(() => result.current.setSort(bySize));
    await waitFor(() => expect(result.current.sort).toEqual(bySize));
    expect(result.current.sortPinned).toBe(true);
    expect(result.current.pinned).toBe(false);
    expect(result.current.mode).toBe("tree");
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({ path: "/photos", sort: bySize }));
    expect(JSON.parse(localStorage.getItem("fdrive.sort") ?? "")).toEqual({
      key: "ext",
      direction: "asc",
    });
  });
  it("uses a server sort pin beside a mode pin, makes it the default and unpins only the sort", async () => {
    mocks.get.mockResolvedValue({ view: { path: "/photos", mode: "grid", sort: bySize } });
    const { result } = renderHook(() => useFolderView("/photos"), { wrapper });
    await waitFor(() => expect(result.current.sortPinned).toBe(true));
    expect(result.current.sort).toEqual(bySize);
    expect(result.current.mode).toBe("grid");
    act(() => result.current.makeDefaultSort());
    expect(JSON.parse(localStorage.getItem("fdrive.sort") ?? "")).toEqual(bySize);
    mocks.get.mockResolvedValue({ view: { path: "/photos", mode: "grid", sort: null } });
    act(() => result.current.useDefaultSort());
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith({ path: "/photos", part: "sort" }),
    );
    await waitFor(() => expect(result.current.sortPinned).toBe(false));
    expect(result.current.pinned).toBe(true);
    expect(result.current.sort).toEqual(bySize);
  });
  it("rolls back a failed sort save with its own message", async () => {
    mocks.set.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useFolderView("/photos"), { wrapper });
    await waitFor(() => expect(result.current.disabled).toBe(false));
    act(() => result.current.setSort(bySize));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Could not save the folder sort."),
    );
    await waitFor(() => expect(result.current.disabled).toBe(false));
    expect(result.current.sort).toEqual({ key: "name", direction: "asc" });
  });
});

it("resets saved pins and invalidates the view cache", async () => {
  client.setQueryData(queryKeys.folderViews.path("/"), {
    view: { path: "/", mode: "grid" },
  });
  const { result } = renderHook(useResetFolderViews, { wrapper });
  await act(async () => result.current.mutateAsync());
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(client.getQueryState(queryKeys.folderViews.path("/"))?.isInvalidated).toBe(true);
  expect(mocks.success).toHaveBeenCalled();
});

it("reports reset errors", async () => {
  mocks.reset.mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(useResetFolderViews, { wrapper });
  await act(async () => {
    await expect(result.current.mutateAsync()).rejects.toThrow("offline");
  });
  expect(mocks.error).toHaveBeenCalledWith("Could not reset folder views.");
  expect(mocks.reset).toHaveBeenCalledOnce();
});

it("allows saving another folder while the first folder is still saving", async () => {
  const first = Promise.withResolvers<void>();
  mocks.set.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true });
  const { result, rerender } = renderHook(({ path }) => useFolderView(path), {
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
