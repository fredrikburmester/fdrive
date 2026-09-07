// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const archiveEntriesMock = vi.fn();

vi.mock("@/lib/preview/deps", () => ({
  apiClient: {
    archiveEntries: (...args: unknown[]) => archiveEntriesMock(...args),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return { queryClient, wrapper };
}

beforeEach(() => {
  archiveEntriesMock.mockReset();
});

describe("archiveEntriesKey", () => {
  it("keys by the archive's own path", async () => {
    const { archiveEntriesKey } = await import("./queries");
    expect(archiveEntriesKey("/a.zip")).toEqual(["fs", "archiveEntries", "/a.zip"]);
  });
});

describe("useArchiveEntries", () => {
  it("returns the archive-entries response for the given path", async () => {
    const { useArchiveEntries } = await import("./queries");
    const payload = {
      format: "zip",
      entries: [{ path: "a.txt", kind: "file", size: 1, modifiedAt: null }],
      truncated: false,
    };
    archiveEntriesMock.mockResolvedValue(payload);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useArchiveEntries("/a.zip"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(payload));
    expect(archiveEntriesMock).toHaveBeenCalledWith("/a.zip");
  });

  it("surfaces a rejected request as an error", async () => {
    const { useArchiveEntries } = await import("./queries");
    archiveEntriesMock.mockRejectedValue(new Error("not a readable archive"));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useArchiveEntries("/bad.zip"), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
