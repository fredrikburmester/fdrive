// @vitest-environment jsdom
import type { FolderSizeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const folderSizeMock = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    folderSize: (...args: unknown[]) => folderSizeMock(...args),
  },
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  folderSizeMock.mockReset();
});

describe("useFolderSize", () => {
  it("fetches a folder's size when enabled", async () => {
    const response: FolderSizeResponse = {
      path: "/photos",
      bytes: 4096,
      files: 3,
      indexed: true,
    };
    folderSizeMock.mockResolvedValue(response);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { useFolderSize } = await import("./queries.ts");

    const { result } = renderHook(() => useFolderSize("/photos", { enabled: true }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(response);
    expect(folderSizeMock).toHaveBeenCalledWith("/photos");
  });

  it("never fetches while disabled", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { useFolderSize } = await import("./queries.ts");

    const { result } = renderHook(() => useFolderSize("/photos", { enabled: false }), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.isPending).toBe(true);
    expect(folderSizeMock).not.toHaveBeenCalled();
  });
});
