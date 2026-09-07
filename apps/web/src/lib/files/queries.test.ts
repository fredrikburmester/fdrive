// @vitest-environment jsdom
import { ApiClientError, type FsEntry } from "@fdrive/contracts";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountTransition } from "@/lib/account/transition";
import { affectedListKeys, describeFsError } from "./queries";

function entry(overrides: Partial<FsEntry> & Pick<FsEntry, "path" | "kind">): FsEntry {
  return {
    name: overrides.path.split("/").at(-1) ?? overrides.path,
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
    ...overrides,
  };
}

const listMock = vi.fn();
const mkdirMock = vi.fn();
const renameMock = vi.fn();
const moveMock = vi.fn();
const copyMock = vi.fn();
const removeMock = vi.fn();
const duplicateMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("./deps", () => ({
  apiClient: {
    list: (...args: unknown[]) => listMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    rename: (...args: unknown[]) => renameMock(...args),
    move: (...args: unknown[]) => moveMock(...args),
    copy: (...args: unknown[]) => copyMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
    duplicate: (...args: unknown[]) => duplicateMock(...args),
  },
  snapshotTabApiClient: () => ({
    list: (...args: unknown[]) => listMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    rename: (...args: unknown[]) => renameMock(...args),
    move: (...args: unknown[]) => moveMock(...args),
    copy: (...args: unknown[]) => copyMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
    duplicate: (...args: unknown[]) => duplicateMock(...args),
  }),
  queryKeys: {
    fs: {
      list: (path: string) => ["fs", "list", path] as const,
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

describe("affectedListKeys", () => {
  it("invalidates the created path's parent for mkdir", () => {
    expect(affectedListKeys({ op: "mkdir", paths: ["/a/new"] })).toEqual([["fs", "list", "/a"]]);
  });

  it("invalidates each deleted path's parent for delete", () => {
    expect(affectedListKeys({ op: "delete", paths: ["/a/x", "/b/y"] })).toEqual(
      expect.arrayContaining([
        ["fs", "list", "/a"],
        ["fs", "list", "/b"],
      ]),
    );
  });

  it("invalidates only the target's parent for copy, not the source's", () => {
    expect(affectedListKeys({ op: "copy", paths: ["/a/src"], targets: ["/b/dst"] })).toEqual([
      ["fs", "list", "/b"],
    ]);
  });

  it("invalidates both parents for rename", () => {
    const keys = affectedListKeys({ op: "rename", paths: ["/a/old"], targets: ["/a/new"] });
    expect(keys).toEqual([["fs", "list", "/a"]]);
  });

  it("invalidates both parents for move across directories", () => {
    const keys = affectedListKeys({ op: "move", paths: ["/a/x"], targets: ["/b/x"] });
    expect(keys).toEqual(
      expect.arrayContaining([
        ["fs", "list", "/a"],
        ["fs", "list", "/b"],
      ]),
    );
    expect(keys).toHaveLength(2);
  });

  it("dedupes when source and target share a parent", () => {
    const keys = affectedListKeys({ op: "move", paths: ["/a/x"], targets: ["/a/y"] });
    expect(keys).toEqual([["fs", "list", "/a"]]);
  });

  it("handles missing targets for rename/move", () => {
    expect(affectedListKeys({ op: "rename", paths: ["/a/old"] })).toEqual([["fs", "list", "/a"]]);
  });

  it("invalidates the new entry's parent for duplicate", () => {
    expect(affectedListKeys({ op: "duplicate", paths: ["/a/report copy.pdf"] })).toEqual([
      ["fs", "list", "/a"],
    ]);
  });
});

describe("describeFsError", () => {
  it("uses the ApiClientError message", () => {
    const error = new ApiClientError("not_found", "no such file", 404);
    expect(describeFsError(error, "fallback")).toBe("no such file");
  });

  it("uses the fallback for a non-ApiClientError", () => {
    expect(describeFsError(new Error("boom"), "fallback")).toBe("fallback");
  });
});

function createWrapper(options?: { staleTime?: number; onMutate?: () => Promise<void> }) {
  const queryClient = new QueryClient({
    mutationCache: new MutationCache(options?.onMutate ? { onMutate: options.onMutate } : {}),
    defaultOptions: {
      queries: { retry: false, staleTime: options?.staleTime ?? 0 },
      mutations: { retry: false },
    },
  });
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return { queryClient, wrapper };
}

beforeEach(() => {
  listMock.mockReset();
  mkdirMock.mockReset();
  renameMock.mockReset();
  moveMock.mockReset();
  copyMock.mockReset();
  removeMock.mockReset();
  duplicateMock.mockReset();
  toastErrorMock.mockReset();
});

describe("useListing", () => {
  it("fetches and returns the listing for a path", async () => {
    const { useListing } = await import("./queries");
    listMock.mockResolvedValue({ path: "/a", entries: [] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useListing("/a"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listMock).toHaveBeenCalledWith("/a");
    expect(result.current.data).toEqual({ path: "/a", entries: [] });
  });
});

describe("useListing options", () => {
  it("does not fetch while enabled is false", async () => {
    const { useListing } = await import("./queries");
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useListing("/a", { enabled: false }), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe("useMkdir", () => {
  it("invalidates the parent listing on success", async () => {
    const { useMkdir } = await import("./queries");
    mkdirMock.mockResolvedValue({
      name: "new",
      path: "/a/new",
      kind: "dir",
      size: 0,
      modifiedAt: new Date().toISOString(),
      ext: "",
      mime: null,
    });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useMkdir(), { wrapper });
    result.current.mutate("/a/new");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mkdirMock).toHaveBeenCalledWith("/a/new");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
  });

  it("shows a toast on failure", async () => {
    const { useMkdir } = await import("./queries");
    mkdirMock.mockRejectedValue(new ApiClientError("conflict", "already exists", 409));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useMkdir(), { wrapper });
    result.current.mutate("/a/new");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastErrorMock).toHaveBeenCalledWith("already exists");
  });
});

describe("useRename", () => {
  it("invalidates the affected listing using the result path", async () => {
    const { useRename } = await import("./queries");
    renameMock.mockResolvedValue({
      name: "b",
      path: "/a/b",
      kind: "file",
      size: 0,
      modifiedAt: new Date().toISOString(),
      ext: "",
      mime: null,
    });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRename(), { wrapper });
    result.current.mutate({ path: "/a/old", newName: "b" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(renameMock).toHaveBeenCalledWith("/a/old", "b");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
  });
});

describe("useMove", () => {
  it("calls apiClient.move and invalidates both parents", async () => {
    const { useMove } = await import("./queries");
    moveMock.mockResolvedValue({
      name: "x",
      path: "/b/x",
      kind: "file",
      size: 0,
      modifiedAt: new Date().toISOString(),
      ext: "",
      mime: null,
    });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useMove(), { wrapper });
    result.current.mutate({ path: "/a/x", target: "/b/x" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(moveMock).toHaveBeenCalledWith("/a/x", "/b/x");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/b"] });
  });
});

describe("useCopy", () => {
  it("calls apiClient.copy and invalidates only the target's parent", async () => {
    const { useCopy } = await import("./queries");
    copyMock.mockResolvedValue({
      name: "x",
      path: "/b/x",
      kind: "file",
      size: 0,
      modifiedAt: new Date().toISOString(),
      ext: "",
      mime: null,
    });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCopy(), { wrapper });
    result.current.mutate({ path: "/a/x", target: "/b/x" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(copyMock).toHaveBeenCalledWith("/a/x", "/b/x");
    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["fs", "list", "/b"] });
  });
});

describe("useDuplicate", () => {
  it("calls apiClient.duplicate and invalidates the new entry's parent", async () => {
    const { useDuplicate } = await import("./queries");
    duplicateMock.mockResolvedValue({
      name: "report copy.pdf",
      path: "/a/report copy.pdf",
      kind: "file",
      size: 0,
      modifiedAt: new Date().toISOString(),
      ext: ".pdf",
      mime: null,
    });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDuplicate(), { wrapper });
    result.current.mutate("/a/report.pdf");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(duplicateMock).toHaveBeenCalledWith("/a/report.pdf");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
  });

  it("shows a toast on failure", async () => {
    const { useDuplicate } = await import("./queries");
    duplicateMock.mockRejectedValue(new ApiClientError("not_found", "no such file", 404));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDuplicate(), { wrapper });
    result.current.mutate("/a/report.pdf");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastErrorMock).toHaveBeenCalledWith("no such file");
  });
});

describe("useTreeChildren", () => {
  it("returns an empty map when nothing is expanded", async () => {
    const { useTreeChildren } = await import("./queries");
    const { wrapper } = createWrapper();
    const dirA = entry({ path: "/a", kind: "dir" });

    const { result } = renderHook(() => useTreeChildren([dirA], new Set()), { wrapper });

    expect(result.current.size).toBe(0);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("fetches an expanded root-level directory's entries", async () => {
    const { useTreeChildren } = await import("./queries");
    const dirA = entry({ path: "/a", kind: "dir" });
    const fileX = entry({ path: "/a/x.txt", kind: "file" });
    listMock.mockResolvedValue({ path: "/a", entries: [fileX] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTreeChildren([dirA], new Set(["/a"])), { wrapper });

    await waitFor(() => expect(result.current.get("/a")).toEqual([fileX]));
    expect(listMock).toHaveBeenCalledWith("/a");
  });

  it("converges on nested expanded directories across renders", async () => {
    const { useTreeChildren } = await import("./queries");
    const dirA = entry({ path: "/a", kind: "dir" });
    const dirAB = entry({ path: "/a/b", kind: "dir" });
    const fileABC = entry({ path: "/a/b/c.txt", kind: "file" });
    listMock.mockImplementation((path: string) => {
      if (path === "/a") {
        return Promise.resolve({ path, entries: [dirAB] });
      }
      if (path === "/a/b") {
        return Promise.resolve({ path, entries: [fileABC] });
      }
      return Promise.resolve({ path, entries: [] });
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTreeChildren([dirA], new Set(["/a", "/a/b"])), {
      wrapper,
    });

    await waitFor(() => expect(result.current.get("/a/b")).toEqual([fileABC]));
    expect(result.current.get("/a")).toEqual([dirAB]);
  });

  it("re-fetches once the reachable set changes on a later render", async () => {
    const { useTreeChildren } = await import("./queries");
    const dirA = entry({ path: "/a", kind: "dir" });
    listMock.mockResolvedValue({ path: "/a", entries: [] });
    const { wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ expanded }: { expanded: ReadonlySet<string> }) => useTreeChildren([dirA], expanded),
      { wrapper, initialProps: { expanded: new Set<string>() } },
    );

    expect(result.current.size).toBe(0);

    act(() => {
      rerender({ expanded: new Set(["/a"]) });
    });

    await waitFor(() => expect(result.current.get("/a")).toEqual([]));
  });
});

describe("useListings", () => {
  it("returns an empty map for no paths and fetches nothing", async () => {
    const { useListings } = await import("./queries");
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useListings([]), { wrapper });

    expect(result.current.size).toBe(0);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("fetches every given path independently and keys results by path", async () => {
    const { useListings } = await import("./queries");
    listMock.mockImplementation((path: string) =>
      Promise.resolve({
        path,
        entries: path === "/a" ? [entry({ path: "/a/x", kind: "dir" })] : [],
      }),
    );
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useListings(["/a", "/b"]), { wrapper });

    await waitFor(() => expect(result.current.get("/a")?.data).toBeDefined());
    await waitFor(() => expect(result.current.get("/b")?.data).toBeDefined());
    expect(listMock).toHaveBeenCalledWith("/a");
    expect(listMock).toHaveBeenCalledWith("/b");
    expect(result.current.get("/a")?.data?.entries).toEqual([entry({ path: "/a/x", kind: "dir" })]);
    expect(result.current.get("/b")?.data?.entries).toEqual([]);
  });

  it("reports isLoading true before a path's listing resolves", async () => {
    const { useListings } = await import("./queries");
    let resolveList: (() => void) | undefined;
    listMock.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          resolveList = () => resolve({ path, entries: [] });
        }),
    );
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useListings(["/a"]), { wrapper });

    expect(result.current.get("/a")?.isLoading).toBe(true);
    expect(result.current.get("/a")?.data).toBeUndefined();

    resolveList?.();
    await waitFor(() => expect(result.current.get("/a")?.isLoading).toBe(false));
  });

  it("shares the cache with useListing for the same path", async () => {
    const { useListing, useListings } = await import("./queries");
    listMock.mockResolvedValue({ path: "/a", entries: [] });
    // A non-zero staleTime, matching the app's real default (see
    // `app/providers.tsx`), so the second mount reuses the cached value
    // instead of refetching in the background: the whole point of sharing
    // `fs.list` query keys between `useListing` and `useListings`.
    const { wrapper } = createWrapper({ staleTime: 60_000 });

    const first = renderHook(() => useListing("/a"), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    listMock.mockClear();

    const second = renderHook(() => useListings(["/a"]), { wrapper });
    expect(second.result.current.get("/a")?.data).toEqual({ path: "/a", entries: [] });
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe("useDelayedFlag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts false", async () => {
    const { useDelayedFlag } = await import("./queries");
    const { result } = renderHook(() => useDelayedFlag(true, 200));
    expect(result.current).toBe(false);
  });

  it("stays false before the delay elapses", async () => {
    const { useDelayedFlag } = await import("./queries");
    const { result } = renderHook(() => useDelayedFlag(true, 200));

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(result.current).toBe(false);
  });

  it("becomes true once the delay elapses while still active", async () => {
    const { useDelayedFlag } = await import("./queries");
    const { result } = renderHook(() => useDelayedFlag(true, 200));

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current).toBe(true);
  });

  it("never becomes true once active goes false before the delay", async () => {
    const { useDelayedFlag } = await import("./queries");
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useDelayedFlag(active, 200),
      {
        initialProps: { active: true },
      },
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current).toBe(false);
  });

  it("resets to false when active flips back off after becoming true", async () => {
    const { useDelayedFlag } = await import("./queries");
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useDelayedFlag(active, 200),
      {
        initialProps: { active: true },
      },
    );

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});

describe("useDelete", () => {
  it("calls apiClient.remove and invalidates each deleted parent", async () => {
    const { useDelete } = await import("./queries");
    removeMock.mockResolvedValue({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDelete(), { wrapper });
    result.current.mutate([{ path: "/a/x", kind: "file" }]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(removeMock).toHaveBeenCalledWith([{ path: "/a/x", kind: "file" }]);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
  });
});

describe("identity-bound filesystem mutations", () => {
  it("rejects a queued same-path delete after its displayed login changes", async () => {
    const { useDelete } = await import("./queries");
    const gate = Promise.withResolvers<void>();
    const entered = vi.fn(() => gate.promise);
    const { wrapper, queryClient } = createWrapper({ onMutate: entered });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result, rerender } = renderHook(() => useDelete(), { wrapper });
    act(() => result.current.mutate([{ path: "/same.txt", kind: "file" }]));
    await waitFor(() => expect(entered).toHaveBeenCalled());
    act(() => {
      accountTransition.begin();
      accountTransition.finish(true);
    });
    rerender();
    gate.resolve();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(removeMock).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("rejects mutations while a login change is pending", async () => {
    const { useRename } = await import("./queries");
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRename(), { wrapper });
    accountTransition.begin();
    try {
      await act(async () => {
        await expect(
          result.current.mutateAsync({ path: "/same.txt", newName: "changed.txt" }),
        ).rejects.toThrow("The active login changed.");
      });
      expect(renameMock).not.toHaveBeenCalled();
    } finally {
      accountTransition.finish(false);
    }
  });

  it("ignores late success and failure callbacks from the previous login", async () => {
    const { useRename } = await import("./queries");
    for (const succeeds of [true, false]) {
      const response = Promise.withResolvers<FsEntry>();
      renameMock.mockReturnValue(response.promise);
      const { wrapper, queryClient } = createWrapper();
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const { result, unmount } = renderHook(() => useRename(), { wrapper });
      act(() => result.current.mutate({ path: "/same.txt", newName: "changed.txt" }));
      await waitFor(() => expect(renameMock).toHaveBeenCalled());
      accountTransition.begin();
      accountTransition.finish(true);
      if (succeeds) response.resolve(entry({ path: "/changed.txt", kind: "file" }));
      else response.reject(new Error("old failure"));
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(invalidate).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
      unmount();
      renameMock.mockClear();
    }
  });
});

it("refreshes after mkdir while the first directory listing is still pending", async () => {
  const { useListing, useMkdir } = await import("./queries");
  const stale = Promise.withResolvers<{ path: string; entries: FsEntry[] }>();
  const created = entry({ path: "/a/new", kind: "dir" });
  listMock.mockReturnValueOnce(stale.promise).mockResolvedValue({ path: "/a", entries: [created] });
  mkdirMock.mockResolvedValue(created);
  const { wrapper } = createWrapper();
  const { result } = renderHook(() => ({ listing: useListing("/a"), mkdir: useMkdir() }), {
    wrapper,
  });
  await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
  await act(async () => {
    await result.current.mkdir.mutateAsync("/a/new");
  });
  await waitFor(() => expect(result.current.listing.data?.entries).toEqual([created]));
  await act(async () => {
    stale.resolve({ path: "/a", entries: [] });
    await stale.promise;
  });
  expect(result.current.listing.data?.entries).toEqual([created]);
  expect(listMock).toHaveBeenCalledTimes(2);
});
