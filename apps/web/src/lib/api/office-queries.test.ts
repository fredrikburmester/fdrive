// @vitest-environment jsdom
import type { OfficeStatusResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { officeStatusQueryOptions, useOfficeStatus } from "./office-queries";

const status: OfficeStatusResponse = {
  available: true,
  product: "onlyoffice",
  extensions: { view: ["docx"], edit: ["docx"], convert: [] },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("deduplicates and caches capabilities without caching session tokens", async () => {
  const fetcher = vi.spyOn(apiClient, "officeStatus").mockResolvedValue(status);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: query }, children);
  const first = renderHook(() => useOfficeStatus(), { wrapper });
  const second = renderHook(() => useOfficeStatus(), { wrapper });
  await waitFor(() => expect(first.result.current.data).toEqual(status));
  expect(second.result.current.data).toEqual(status);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(query.getQueryCache().getAll()).toHaveLength(1);
});
it("discovers a newly started editor without reloading the application", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const fetcher = vi
    .spyOn(apiClient, "officeStatus")
    .mockResolvedValueOnce({
      available: false,
      product: null,
      extensions: { view: [], edit: [], convert: [] },
    })
    .mockResolvedValue(status);
  const observer = new QueryObserver(client, officeStatusQueryOptions());
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data?.available).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(observer.getCurrentResult().data).toEqual(status);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    client.clear();
    vi.useRealTimers();
  }
});
