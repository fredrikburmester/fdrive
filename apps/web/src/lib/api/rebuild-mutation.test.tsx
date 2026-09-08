// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const rebuildMock = vi.fn();

vi.mock("./client.js", () => ({
  apiClient: {
    systemRebuildIndexerThumbnails: (...args: unknown[]) => rebuildMock(...args),
  },
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useRebuildIndexerThumbnails", () => {
  it("finishes before slow background status refreshes", async () => {
    rebuildMock.mockResolvedValue({ started: true, total: 6 });
    const queryClient = new QueryClient();
    let settleRefresh: (() => void) | undefined;
    const slowRefresh = new Promise<void>((resolve) => {
      settleRefresh = resolve;
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockReturnValue(slowRefresh);
    const { useRebuildIndexerThumbnails } = await import("./system-queries.js");
    const { result } = renderHook(() => useRebuildIndexerThumbnails(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ root: "sftpgo" });

    await waitFor(() => expect(rebuildMock).toHaveBeenCalledWith({ root: "sftpgo" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["system", "indexer"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["system", "thumbnails"] });

    settleRefresh?.();
  });
});
