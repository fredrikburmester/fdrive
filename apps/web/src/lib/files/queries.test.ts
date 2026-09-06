// @vitest-environment jsdom
import { ApiClientError, type FsEntry } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const toastErrorMock = vi.fn();

vi.mock("./deps", () => ({
  apiClient: {
    list: (...args: unknown[]) => listMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    rename: (...args: unknown[]) => renameMock(...args),
    move: (...args: unknown[]) => moveMock(...args),
    copy: (...args: unknown[]) => copyMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  },
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
  listMock.mockReset();
  mkdirMock.mockReset();
  renameMock.mockReset();
  moveMock.mockReset();
  copyMock.mockReset();
  removeMock.mockReset();
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
