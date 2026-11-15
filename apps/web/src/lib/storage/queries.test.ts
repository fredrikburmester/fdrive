// @vitest-environment jsdom
import type { StorageUsageResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const storageUsage = vi.fn();

vi.mock("@/lib/api/client", () => ({ apiClient: { storageUsage: () => storageUsage() } }));

describe("useStorageUsage", () => {
  it("fetches the signed-in login's storage", async () => {
    const response: StorageUsageResponse = {
      indexed: true,
      used: 10,
      limit: null,
      kinds: [{ kind: "other", bytes: 10 }],
      largest: [],
      duplicates: [],
    };
    storageUsage.mockResolvedValue(response);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { useStorageUsage } = await import("./queries.ts");

    const { result } = renderHook(() => useStorageUsage(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });

    await waitFor(() => expect(result.current.data).toEqual(response));
    expect(storageUsage).toHaveBeenCalledTimes(1);
  });
});
