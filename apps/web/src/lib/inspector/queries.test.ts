// @vitest-environment jsdom
import type { FolderSizeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const folderSizeMock = vi.fn();
const photoDetailsMock = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    folderSize: (...args: unknown[]) => folderSizeMock(...args),
    photoDetails: (...args: unknown[]) => photoDetailsMock(...args),
  },
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  folderSizeMock.mockReset();
  photoDetailsMock.mockReset();
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

describe("usePhotoDetails", () => {
  it("fetches an image's details when enabled, and nothing while disabled", async () => {
    const details = {
      takenAt: "2024-05-01T14:03:09",
      camera: "Apple iPhone 15 Pro",
      width: 3024,
      height: 4032,
      latitude: null,
      longitude: null,
    };
    photoDetailsMock.mockResolvedValue(details);
    const queryClient = new QueryClient();
    const { usePhotoDetails } = await import("./queries.ts");

    const disabled = renderHook(() => usePhotoDetails("/b.jpg", { enabled: false }), {
      wrapper: createWrapper(queryClient),
    });
    const { result } = renderHook(() => usePhotoDetails("/a.jpg", { enabled: true }), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(details);
    expect(disabled.result.current.isPending).toBe(true);
    expect(photoDetailsMock).toHaveBeenCalledTimes(1);
    expect(photoDetailsMock).toHaveBeenCalledWith("/a.jpg");
  });
});
