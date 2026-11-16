// @vitest-environment jsdom
import { ApiClientError, type FsEntry } from "@fdrive/contracts";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const trashListMock = vi.fn();
const trashRestoreMock = vi.fn();
const trashPurgeMock = vi.fn();
const trashEmptyMock = vi.fn();
const toastErrorMock = vi.fn();

function fakeApiClient() {
  return {
    trashList: (...args: unknown[]) => trashListMock(...args),
    trashRestore: (...args: unknown[]) => trashRestoreMock(...args),
    trashPurge: (...args: unknown[]) => trashPurgeMock(...args),
    trashEmpty: (...args: unknown[]) => trashEmptyMock(...args),
  };
}

vi.mock("./deps", () => ({
  apiClient: fakeApiClient(),
  queryKeys: {
    trash: {
      status: () => ["trash", "status"] as const,
      list: () => ["trash", "list"] as const,
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
  trashListMock.mockReset();
  trashRestoreMock.mockReset();
  trashPurgeMock.mockReset();
  trashEmptyMock.mockReset();
  toastErrorMock.mockReset();
});

describe("useTrash", () => {
  it("fetches and returns the trash listing", async () => {
    const { useTrash } = await import("./queries");
    trashListMock.mockResolvedValue({ entries: [], truncated: false });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTrash(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ entries: [], truncated: false });
  });
});

describe("useTrashRestore", () => {
  it("restores without a target and invalidates the trash list and each restored parent", async () => {
    const { useTrashRestore } = await import("./queries");
    const restored = entry({ path: "/docs/a.txt", kind: "file" });
    trashRestoreMock.mockResolvedValue({ restored: [restored] });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTrashRestore(), { wrapper });
    result.current.mutate({ ids: ["docs/a.txt/123"] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(trashRestoreMock).toHaveBeenCalledWith({ ids: ["docs/a.txt/123"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["trash", "list"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fs", "list", "/docs"] });
  });

  it("passes a target when restoring to a different folder", async () => {
    const { useTrashRestore } = await import("./queries");
    trashRestoreMock.mockResolvedValue({ restored: [] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTrashRestore(), { wrapper });
    result.current.mutate({ ids: ["docs/a.txt/123"], target: "/other/a.txt" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(trashRestoreMock).toHaveBeenCalledWith({
      ids: ["docs/a.txt/123"],
      target: "/other/a.txt",
    });
  });

  it("shows a generic toast for a non-conflict failure", async () => {
    const { useTrashRestore } = await import("./queries");
    trashRestoreMock.mockRejectedValue(new ApiClientError("not_found", "no such item", 404));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTrashRestore(), { wrapper });
    result.current.mutate({ ids: ["docs/a.txt/123"] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastErrorMock).toHaveBeenCalledWith("no such item");
  });

  it("suppresses the generic toast for a restore conflict, leaving it to the caller", async () => {
    const { useTrashRestore } = await import("./queries");
    trashRestoreMock.mockRejectedValue(new ApiClientError("conflict", "a.txt already exists", 409));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTrashRestore(), { wrapper });
    result.current.mutate({ ids: ["docs/a.txt/123"] });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe("isRestoreConflict", () => {
  it("is true for a conflict ApiClientError", async () => {
    const { isRestoreConflict } = await import("./queries");
    expect(isRestoreConflict(new ApiClientError("conflict", "already exists", 409))).toBe(true);
  });

  it("is false for another ApiClientError kind", async () => {
    const { isRestoreConflict } = await import("./queries");
    expect(isRestoreConflict(new ApiClientError("not_found", "no such item", 404))).toBe(false);
  });

  it("is false for a plain error", async () => {
    const { isRestoreConflict } = await import("./queries");
    expect(isRestoreConflict(new Error("boom"))).toBe(false);
  });
});

describe("useTrashPurge", () => {
  it("purges and invalidates only the trash list", async () => {
    const { useTrashPurge } = await import("./queries");
    trashPurgeMock.mockResolvedValue({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTrashPurge(), { wrapper });
    result.current.mutate(["docs/a.txt/123"]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(trashPurgeMock).toHaveBeenCalledWith({ ids: ["docs/a.txt/123"] });
    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["trash", "list"] });
  });

  it("shows a toast on failure", async () => {
    const { useTrashPurge } = await import("./queries");
    trashPurgeMock.mockRejectedValue(new ApiClientError("not_found", "no such item", 404));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useTrashPurge(), { wrapper });
    result.current.mutate(["docs/a.txt/123"]);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastErrorMock).toHaveBeenCalledWith("no such item");
  });
});

describe("useTrashEmpty", () => {
  it("empties the trash and invalidates the trash list", async () => {
    const { useTrashEmpty } = await import("./queries");
    trashEmptyMock.mockResolvedValue({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTrashEmpty(), { wrapper });
    result.current.mutate(undefined);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(trashEmptyMock).toHaveBeenCalledWith();
    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["trash", "list"] });
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
