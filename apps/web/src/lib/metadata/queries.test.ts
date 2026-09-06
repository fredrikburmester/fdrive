// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
      list: (path: string) => ["fs", "list", path] as const,
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
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
