// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { MutationCache, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountTransition } from "@/lib/account/transition";

function entry(path: string, overrides: Partial<FsEntry> = {}): FsEntry {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    kind: "file",
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
    ...overrides,
  };
}

const listTagsMock = vi.fn();
const createTagMock = vi.fn();
const updateTagMock = vi.fn();
const deleteTagMock = vi.fn();
const tagFilesMock = vi.fn();
const setFileTagsMock = vi.fn();
const listFavoritesMock = vi.fn();
const addFavoriteMock = vi.fn();
const removeFavoriteMock = vi.fn();
const listRecentsMock = vi.fn();
const touchRecentMock = vi.fn();
const statMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("./deps", () => ({
  snapshotTabApiClient: () => ({
    createTag: (...args: unknown[]) => createTagMock(...args),
    updateTag: (...args: unknown[]) => updateTagMock(...args),
    deleteTag: (...args: unknown[]) => deleteTagMock(...args),
    touchRecent: (...args: unknown[]) => touchRecentMock(...args),
    setFileTags: (...args: unknown[]) => setFileTagsMock(...args),
    addFavorite: (...args: unknown[]) => addFavoriteMock(...args),
    removeFavorite: (...args: unknown[]) => removeFavoriteMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
  }),
  apiClient: {
    listTags: (...args: unknown[]) => listTagsMock(...args),
    createTag: (...args: unknown[]) => createTagMock(...args),
    updateTag: (...args: unknown[]) => updateTagMock(...args),
    deleteTag: (...args: unknown[]) => deleteTagMock(...args),
    tagFiles: (...args: unknown[]) => tagFilesMock(...args),
    setFileTags: (...args: unknown[]) => setFileTagsMock(...args),
    listFavorites: (...args: unknown[]) => listFavoritesMock(...args),
    addFavorite: (...args: unknown[]) => addFavoriteMock(...args),
    removeFavorite: (...args: unknown[]) => removeFavoriteMock(...args),
    listRecents: (...args: unknown[]) => listRecentsMock(...args),
    touchRecent: (...args: unknown[]) => touchRecentMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
  },
  queryKeys: {
    tags: {
      list: () => ["tags", "list"] as const,
      files: (id: string) => ["tags", "files", id] as const,
    },
    favorites: {
      list: () => ["favorites", "list"] as const,
    },
    recents: {
      list: () => ["recents", "list"] as const,
    },
    fs: {
      stat: (path: string) => ["fs", "stat", path] as const,
      list: (path: string) => ["fs", "list", path] as const,
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

function createWrapper(onMutate?: () => Promise<void>) {
  const queryClient = new QueryClient({
    mutationCache: new MutationCache(onMutate ? { onMutate } : {}),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return { queryClient, wrapper };
}

beforeEach(() => {
  for (const mock of [
    listTagsMock,
    createTagMock,
    updateTagMock,
    deleteTagMock,
    tagFilesMock,
    setFileTagsMock,
    listFavoritesMock,
    addFavoriteMock,
    removeFavoriteMock,
    listRecentsMock,
    touchRecentMock,
    statMock,
    toastErrorMock,
  ]) {
    mock.mockReset();
  }
});

describe("useTags", () => {
  it("returns the tags array from the response", async () => {
    const { useTags } = await import("./queries");
    listTagsMock.mockResolvedValue({ tags: [{ id: "1", name: "Work", color: "blue" }] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTags(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: "1", name: "Work", color: "blue" }]);
  });
});

describe("useTagFiles", () => {
  it("fetches the paths for a tag id", async () => {
    const { useTagFiles } = await import("./queries");
    tagFilesMock.mockResolvedValue({ paths: ["/a.txt"] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTagFiles("tag-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tagFilesMock).toHaveBeenCalledWith("tag-1");
    expect(result.current.data).toEqual(["/a.txt"]);
  });

  it("does not fetch when id is null", async () => {
    const { useTagFiles } = await import("./queries");
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTagFiles(null), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(tagFilesMock).not.toHaveBeenCalled();
  });
});

describe("useTagMutations", () => {
  it("creates a tag and invalidates only the tag list", async () => {
    const { useTagMutations } = await import("./queries");
    createTagMock.mockResolvedValue({ id: "1", name: "Work", color: "blue" });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTagMutations(), { wrapper });
    result.current.createTag.mutate({ name: "Work", color: "blue" });

    await waitFor(() => expect(result.current.createTag.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["tags", "list"] });
  });

  it("shows a toast when create fails", async () => {
    const { useTagMutations } = await import("./queries");
    createTagMock.mockRejectedValue(new Error("boom"));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTagMutations(), { wrapper });
    result.current.createTag.mutate({ name: "Work" });

    await waitFor(() => expect(result.current.createTag.isError).toBe(true));
    expect(toastErrorMock).toHaveBeenCalledWith("Could not create the tag.");
  });

  it("updates a tag and invalidates the tag list and every fs listing", async () => {
    const { useTagMutations } = await import("./queries");
    updateTagMock.mockResolvedValue({ id: "1", name: "Job", color: "blue" });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTagMutations(), { wrapper });
    result.current.updateTag.mutate({ id: "1", patch: { name: "Job" } });

    await waitFor(() => expect(result.current.updateTag.isSuccess).toBe(true));
    expect(updateTagMock).toHaveBeenCalledWith("1", { name: "Job" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tags", "list"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list"] });
  });

  it("shows a toast when update fails", async () => {
    const { useTagMutations } = await import("./queries");
    updateTagMock.mockRejectedValue(new Error("boom"));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTagMutations(), { wrapper });
    result.current.updateTag.mutate({ id: "1", patch: { name: "Job" } });

    await waitFor(() => expect(result.current.updateTag.isError).toBe(true));
    expect(toastErrorMock).toHaveBeenCalledWith("Could not update the tag.");
  });

  it("deletes a tag and invalidates the tag list and every fs listing", async () => {
    const { useTagMutations } = await import("./queries");
    deleteTagMock.mockResolvedValue({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTagMutations(), { wrapper });
    result.current.deleteTag.mutate("1");

    await waitFor(() => expect(result.current.deleteTag.isSuccess).toBe(true));
    expect(deleteTagMock).toHaveBeenCalledWith("1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tags", "list"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list"] });
  });

  it("shows a toast when delete fails", async () => {
    const { useTagMutations } = await import("./queries");
    deleteTagMock.mockRejectedValue(new Error("boom"));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTagMutations(), { wrapper });
    result.current.deleteTag.mutate("1");

    await waitFor(() => expect(result.current.deleteTag.isError).toBe(true));
    expect(toastErrorMock).toHaveBeenCalledWith("Could not delete the tag.");
  });
});

describe("useSetFileTags", () => {
  it("calls setFileTags for every item and invalidates affected listings and tag files", async () => {
    const { useSetFileTags } = await import("./queries");
    setFileTagsMock.mockResolvedValue({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useSetFileTags(), { wrapper });
    result.current.mutate([
      { path: "/a/x.txt", tagIds: ["t1"] },
      { path: "/b/y.txt", tagIds: ["t1"] },
    ]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setFileTagsMock).toHaveBeenCalledWith({ path: "/a/x.txt", tagIds: ["t1"] });
    expect(setFileTagsMock).toHaveBeenCalledWith({ path: "/b/y.txt", tagIds: ["t1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/b"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tags", "files"] });
  });

  it("optimistically patches an already-loaded listing's entry", async () => {
    const { useSetFileTags } = await import("./queries");
    setFileTagsMock.mockImplementation(() => new Promise(() => {}));
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(["fs", "list", "/a"], {
      path: "/a",
      entries: [entry("/a/x.txt", { meta: { tagIds: [], favorite: false } })],
    });

    const { result } = renderHook(() => useSetFileTags(), { wrapper });
    result.current.mutate([{ path: "/a/x.txt", tagIds: ["t1"] }]);

    await waitFor(() => {
      const data = queryClient.getQueryData<{ entries: FsEntry[] }>(["fs", "list", "/a"]);
      expect(data?.entries[0]?.meta?.tagIds).toEqual(["t1"]);
    });
  });

  it("rolls back the optimistic patch and shows a toast on failure", async () => {
    const { useSetFileTags } = await import("./queries");
    setFileTagsMock.mockRejectedValue(new Error("boom"));
    const { wrapper, queryClient } = createWrapper();
    const original = {
      path: "/a",
      entries: [entry("/a/x.txt", { meta: { tagIds: [], favorite: false } })],
    };
    queryClient.setQueryData(["fs", "list", "/a"], original);

    const { result } = renderHook(() => useSetFileTags(), { wrapper });
    result.current.mutate([{ path: "/a/x.txt", tagIds: ["t1"] }]);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(["fs", "list", "/a"])).toEqual(original);
    expect(toastErrorMock).toHaveBeenCalledWith("Could not update tags.");
  });
});

describe("useFavorites", () => {
  it("returns the items array from the response", async () => {
    const { useFavorites } = await import("./queries");
    listFavoritesMock.mockResolvedValue({
      items: [{ path: "/a.txt", kind: "file", addedAt: "2024-01-01T00:00:00.000Z" }],
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFavorites(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { path: "/a.txt", kind: "file", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
  });
});

describe("useToggleFavorite", () => {
  it("calls addFavorite when favoriting, and invalidates the listing and favorites list", async () => {
    const { useToggleFavorite } = await import("./queries");
    addFavoriteMock.mockResolvedValue({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useToggleFavorite(), { wrapper });
    result.current.mutate({ path: "/a/x.txt", favorite: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(addFavoriteMock).toHaveBeenCalledWith({ path: "/a/x.txt" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/a"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["favorites", "list"] });
  });

  it("calls removeFavorite when unfavoriting", async () => {
    const { useToggleFavorite } = await import("./queries");
    removeFavoriteMock.mockResolvedValue({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useToggleFavorite(), { wrapper });
    result.current.mutate({ path: "/a/x.txt", favorite: false });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(removeFavoriteMock).toHaveBeenCalledWith({ path: "/a/x.txt" });
  });

  it("optimistically patches meta.favorite on an already-loaded listing", async () => {
    const { useToggleFavorite } = await import("./queries");
    addFavoriteMock.mockImplementation(() => new Promise(() => {}));
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(["fs", "list", "/a"], {
      path: "/a",
      entries: [entry("/a/x.txt", { meta: { tagIds: [], favorite: false } })],
    });

    const { result } = renderHook(() => useToggleFavorite(), { wrapper });
    result.current.mutate({ path: "/a/x.txt", favorite: true });

    await waitFor(() => {
      const data = queryClient.getQueryData<{ entries: FsEntry[] }>(["fs", "list", "/a"]);
      expect(data?.entries[0]?.meta?.favorite).toBe(true);
    });
  });

  it("rolls back on failure and shows a toast", async () => {
    const { useToggleFavorite } = await import("./queries");
    addFavoriteMock.mockRejectedValue(new Error("boom"));
    const { wrapper, queryClient } = createWrapper();
    const original = {
      path: "/a",
      entries: [entry("/a/x.txt", { meta: { tagIds: [], favorite: false } })],
    };
    queryClient.setQueryData(["fs", "list", "/a"], original);

    const { result } = renderHook(() => useToggleFavorite(), { wrapper });
    result.current.mutate({ path: "/a/x.txt", favorite: true });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(["fs", "list", "/a"])).toEqual(original);
    expect(toastErrorMock).toHaveBeenCalledWith("Could not update favorites.");
  });
});

describe("useRecents", () => {
  it("returns the items array from the response", async () => {
    const { useRecents } = await import("./queries");
    listRecentsMock.mockResolvedValue({
      items: [{ path: "/a.txt", openedAt: "2024-01-01T00:00:00.000Z" }],
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRecents(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ path: "/a.txt", openedAt: "2024-01-01T00:00:00.000Z" }]);
  });
});

describe("useTouchRecent", () => {
  it("calls touchRecent and invalidates the recents list", async () => {
    const { useTouchRecent } = await import("./queries");
    touchRecentMock.mockResolvedValue({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTouchRecent(), { wrapper });
    result.current.mutate("/a.txt");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(touchRecentMock).toHaveBeenCalledWith({ path: "/a.txt" });
    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["recents", "list"] });
  });
});

describe("useResolvedEntries", () => {
  it("resolves each path and reports loading until settled", async () => {
    const { useResolvedEntries } = await import("./queries");
    statMock.mockImplementation((path: string) => Promise.resolve(entry(path)));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useResolvedEntries(["/a", "/b"]), { wrapper });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.entries.map((r) => r.path)).toEqual(["/a", "/b"]);
    expect(result.current.entries.every((r) => r.entry !== null)).toBe(true);
  });

  it("reports a null entry for a path that fails to resolve", async () => {
    const { useResolvedEntries } = await import("./queries");
    statMock.mockImplementation((path: string) =>
      path === "/missing" ? Promise.reject(new Error("gone")) : Promise.resolve(entry(path)),
    );
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useResolvedEntries(["/a", "/missing"]), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.entries.find((r) => r.path === "/missing")?.entry).toBeNull();
  });

  it("starts not loading for an empty path list", async () => {
    const { useResolvedEntries } = await import("./queries");
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useResolvedEntries([]), { wrapper });

    expect(result.current.isLoading).toBe(false);
    await waitFor(() => expect(result.current.entries).toEqual([]));
  });

  it("re-resolves when the path list changes", async () => {
    const { useResolvedEntries } = await import("./queries");
    statMock.mockImplementation((path: string) => Promise.resolve(entry(path)));
    const { wrapper } = createWrapper();

    const { result, rerender } = renderHook(({ paths }) => useResolvedEntries(paths), {
      wrapper,
      initialProps: { paths: ["/a"] },
    });

    await waitFor(() => expect(result.current.entries.map((r) => r.path)).toEqual(["/a"]));

    rerender({ paths: ["/a", "/b"] });

    await waitFor(() => expect(result.current.entries.map((r) => r.path)).toEqual(["/a", "/b"]));
  });
});

it.each(["favorite", "tags"])(
  "late %s failure cannot roll old optimistic cache into a new login",
  async (kind) => {
    const { useSetFileTags, useToggleFavorite } = await import("./queries");
    let reject: ((cause: Error) => void) | undefined;
    const deferred = () =>
      new Promise((_, fail) => {
        reject = fail;
      });
    addFavoriteMock.mockImplementation(deferred);
    setFileTagsMock.mockImplementation(deferred);
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(["fs", "list", "/a"], {
      path: "/a",
      entries: [entry("/a/old", { meta: { tagIds: [], favorite: false } })],
    });
    const { result } = renderHook(
      () => ({ favorite: useToggleFavorite(), tags: useSetFileTags() }),
      { wrapper },
    );
    act(() => {
      if (kind === "favorite") result.current.favorite.mutate({ path: "/a/old", favorite: true });
      else result.current.tags.mutate([{ path: "/a/old", tagIds: ["t"] }]);
    });
    await waitFor(() => expect(reject).toBeDefined());
    act(() => {
      accountTransition.begin();
      queryClient.clear();
      accountTransition.finish(true);
    });
    const fresh = { path: "/a", entries: [entry("/a/new")] };
    queryClient.setQueryData(["fs", "list", "/a"], fresh);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => {
      reject?.(new Error("late failure"));
    });
    expect(queryClient.getQueryData(["fs", "list", "/a"])).toEqual(fresh);
    expect(invalidate).not.toHaveBeenCalled();
  },
);

it.each(["favorite", "tags"])(
  "does not resume %s optimistic work after cancellation overlaps a switch",
  async (kind) => {
    const { useSetFileTags, useToggleFavorite } = await import("./queries");
    const { wrapper, queryClient } = createWrapper();
    let release: (() => void) | undefined;
    vi.spyOn(queryClient, "cancelQueries").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(
      () => ({ favorite: useToggleFavorite(), tags: useSetFileTags() }),
      { wrapper },
    );
    act(() => {
      if (kind === "favorite") result.current.favorite.mutate({ path: "/a/old", favorite: true });
      else result.current.tags.mutate([{ path: "/a/old", tagIds: ["t"] }]);
    });
    await waitFor(() => expect(release).toBeDefined());
    act(() => {
      accountTransition.begin();
      queryClient.clear();
      accountTransition.finish(true);
    });
    const fresh = { path: "/a", entries: [entry("/a/new")] };
    queryClient.setQueryData(["fs", "list", "/a"], fresh);
    await act(async () => {
      release?.();
    });
    expect(addFavoriteMock).not.toHaveBeenCalled();
    expect(setFileTagsMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["fs", "list", "/a"])).toEqual(fresh);
  },
);

describe("identity-bound recent touches", () => {
  it("rejects a queued recent touch after the displayed login changes", async () => {
    const { useTouchRecent } = await import("./queries");
    const gate = Promise.withResolvers<void>();
    const entered = vi.fn(() => gate.promise);
    const { wrapper, queryClient } = createWrapper(entered);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result, rerender } = renderHook(() => useTouchRecent(), { wrapper });
    act(() => result.current.mutate("/same.txt"));
    await waitFor(() => expect(entered).toHaveBeenCalled());
    accountTransition.begin();
    accountTransition.finish(true);
    rerender();
    gate.resolve();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(touchRecentMock).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("rejects touches during a switch and ignores late successful touches", async () => {
    const { useTouchRecent } = await import("./queries");
    const { wrapper, queryClient } = createWrapper();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useTouchRecent(), { wrapper });
    accountTransition.begin();
    try {
      await act(async () => {
        await expect(result.current.mutateAsync("/same.txt")).rejects.toThrow(
          "The active login changed.",
        );
      });
      expect(touchRecentMock).not.toHaveBeenCalled();
    } finally {
      accountTransition.finish(false);
    }
    const response = Promise.withResolvers<void>();
    touchRecentMock.mockReturnValue(response.promise);
    act(() => result.current.mutate("/same.txt"));
    await waitFor(() => expect(touchRecentMock).toHaveBeenCalled());
    accountTransition.begin();
    accountTransition.finish(true);
    response.resolve();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("queued optimistic metadata", () => {
  it("rejects queued same-path favorites and tags before writing the new cache", async () => {
    const { useSetFileTags, useToggleFavorite } = await import("./queries");
    const gate = Promise.withResolvers<void>();
    const entered = vi.fn(() => gate.promise);
    const { wrapper, queryClient } = createWrapper(entered);
    const { result, rerender } = renderHook(
      () => ({ tags: useSetFileTags(), favorite: useToggleFavorite() }),
      { wrapper },
    );
    act(() => {
      result.current.tags.mutate([{ path: "/same.txt", tagIds: ["tag"] }]);
      result.current.favorite.mutate({ path: "/same.txt", favorite: true });
    });
    await waitFor(() => expect(entered).toHaveBeenCalledTimes(2));
    accountTransition.begin();
    accountTransition.finish(true);
    const nextListing = {
      path: "/",
      entries: [entry("/same.txt", { meta: { tagIds: [], favorite: false } })],
    };
    queryClient.setQueryData(["fs", "list", "/"], nextListing);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    rerender();
    gate.resolve();
    await waitFor(() => {
      expect(result.current.tags.isError).toBe(true);
      expect(result.current.favorite.isError).toBe(true);
    });
    expect(setFileTagsMock).not.toHaveBeenCalled();
    expect(addFavoriteMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["fs", "list", "/"])).toEqual(nextListing);
    expect(invalidate).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("rejects queued tag management after switching accounts", async () => {
    const { useTagMutations } = await import("./queries");
    const gate = Promise.withResolvers<void>();
    const entered = vi.fn(() => gate.promise);
    const { wrapper, queryClient } = createWrapper(entered);
    const { result, rerender } = renderHook(() => useTagMutations(), { wrapper });
    act(() => {
      result.current.createTag.mutate({ name: "old tag", color: "red" });
      result.current.updateTag.mutate({ id: "tag", patch: { name: "renamed" } });
      result.current.deleteTag.mutate("tag");
    });
    await waitFor(() => expect(entered).toHaveBeenCalledTimes(3));
    accountTransition.begin();
    accountTransition.finish(true);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    rerender();
    gate.resolve();
    await waitFor(() => {
      expect(result.current.createTag.isError).toBe(true);
      expect(result.current.updateTag.isError).toBe(true);
      expect(result.current.deleteTag.isError).toBe(true);
    });
    expect(createTagMock).not.toHaveBeenCalled();
    expect(updateTagMock).not.toHaveBeenCalled();
    expect(deleteTagMock).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe("preview stat metadata", () => {
  it.each([true, false])(
    "updates the preview's favorite immediately and rolls it back on failure: favorite=%s",
    async (favorite) => {
      const { useToggleFavorite } = await import("./queries");
      const response = Promise.withResolvers<void>();
      (favorite ? addFavoriteMock : removeFavoriteMock).mockReturnValue(response.promise);
      const { wrapper, queryClient } = createWrapper();
      const key = ["fs", "stat", "/preview.txt"];
      const original = entry("/preview.txt", { meta: { favorite: !favorite, tagIds: ["kept"] } });
      queryClient.setQueryData(key, original);
      const { result } = renderHook(() => useToggleFavorite(), { wrapper });
      act(() => result.current.mutate({ path: "/preview.txt", favorite }));
      await waitFor(() =>
        expect(queryClient.getQueryData<FsEntry>(key)?.meta).toEqual({
          favorite,
          tagIds: ["kept"],
        }),
      );
      response.reject(new Error("denied"));
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(queryClient.getQueryData(key)).toEqual(original);
    },
  );

  it("updates preview tags and restores every entry of a shared listing on failure", async () => {
    const { useSetFileTags } = await import("./queries");
    const response = Promise.withResolvers<void>();
    setFileTagsMock.mockReturnValue(response.promise);
    const { wrapper, queryClient } = createWrapper();
    const files = [
      entry("/a.txt", { meta: { favorite: true, tagIds: ["old"] } }),
      entry("/b.txt", { meta: { favorite: false, tagIds: [] } }),
    ];
    const listing = { path: "/", entries: files };
    queryClient.setQueryData(["fs", "list", "/"], listing);
    for (const file of files) queryClient.setQueryData(["fs", "stat", file.path], file);
    const { result } = renderHook(() => useSetFileTags(), { wrapper });
    act(() => result.current.mutate(files.map((file) => ({ path: file.path, tagIds: ["new"] }))));
    await waitFor(() =>
      expect(queryClient.getQueryData<FsEntry>(["fs", "stat", "/a.txt"])?.meta).toEqual({
        favorite: true,
        tagIds: ["new"],
      }),
    );
    expect(queryClient.getQueryData<FsEntry>(["fs", "stat", "/b.txt"])?.meta?.tagIds).toEqual([
      "new",
    ]);
    response.reject(new Error("denied"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(["fs", "list", "/"])).toEqual(listing);
    for (const file of files)
      expect(queryClient.getQueryData(["fs", "stat", file.path])).toEqual(file);
  });

  it.each(["favorite", "tags"] as const)(
    "does not overwrite the new identity stat with a late %s rollback",
    async (kind) => {
      const { useToggleFavorite, useSetFileTags } = await import("./queries");
      const response = Promise.withResolvers<void>();
      addFavoriteMock.mockReturnValue(response.promise);
      setFileTagsMock.mockReturnValue(response.promise);
      const { wrapper, queryClient } = createWrapper();
      const key = ["fs", "stat", "/same.txt"];
      queryClient.setQueryData(key, entry("/same.txt", { meta: { favorite: false, tagIds: [] } }));
      const { result } = renderHook(
        () => ({ favorite: useToggleFavorite(), tags: useSetFileTags() }),
        { wrapper },
      );
      act(() => {
        if (kind === "favorite")
          result.current.favorite.mutate({ path: "/same.txt", favorite: true });
        else result.current.tags.mutate([{ path: "/same.txt", tagIds: ["old"] }]);
      });
      await waitFor(() =>
        expect(kind === "favorite" ? addFavoriteMock : setFileTagsMock).toHaveBeenCalled(),
      );
      accountTransition.begin();
      accountTransition.finish(true);
      const replacement = entry("/same.txt", {
        name: "New login",
        meta: { favorite: false, tagIds: ["new owner"] },
      });
      queryClient.setQueryData(key, replacement);
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      response.reject(new Error("old denial"));
      await waitFor(() => expect(result.current[kind].isError).toBe(true));
      expect(queryClient.getQueryData(key)).toEqual(replacement);
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it.each(["favorite", "tags"] as const)(
    "replaces a late initial stat request after %s changes",
    async (kind) => {
      const { useToggleFavorite, useSetFileTags } = await import("./queries");
      const stale = Promise.withResolvers<FsEntry>();
      const saved = entry("/preview.txt", { meta: { favorite: true, tagIds: ["new"] } });
      const request = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(saved);
      addFavoriteMock.mockResolvedValue({ ok: true });
      setFileTagsMock.mockResolvedValue({ ok: true });
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => ({
          stat: useQuery({ queryKey: ["fs", "stat", "/preview.txt"], queryFn: request }),
          favorite: useToggleFavorite(),
          tags: useSetFileTags(),
        }),
        { wrapper },
      );
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      await act(async () => {
        if (kind === "favorite")
          await result.current.favorite.mutateAsync({ path: "/preview.txt", favorite: true });
        else await result.current.tags.mutateAsync([{ path: "/preview.txt", tagIds: ["new"] }]);
      });
      await waitFor(() => expect(result.current.stat.data).toEqual(saved));
      expect(request).toHaveBeenCalledTimes(2);
      await act(async () => {
        stale.resolve(entry("/preview.txt"));
        await stale.promise;
      });
      expect(result.current.stat.data).toEqual(saved);
    },
  );

  it("refreshes stat subscribers when a tag is renamed or removed", async () => {
    const { useTagMutations } = await import("./queries");
    updateTagMock.mockResolvedValue({ id: "tag" });
    deleteTagMock.mockResolvedValue({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useTagMutations(), { wrapper });
    await act(async () => {
      await result.current.updateTag.mutateAsync({ id: "tag", patch: { name: "new" } });
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["fs", "stat"] }));
    invalidate.mockClear();
    await act(async () => {
      await result.current.deleteTag.mutateAsync("tag");
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["fs", "stat"] }));
  });
});
