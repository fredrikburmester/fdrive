// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { queryKeys } from "./keys";
import { useProviders } from "./provider-queries";

afterEach(() => vi.restoreAllMocks());

it("loads the public storage list once and keeps it fresh for minutes", async () => {
  const providers = { providers: [] };
  const fetcher = vi.spyOn(apiClient, "providers").mockResolvedValue(providers);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const first = renderHook(() => useProviders(), { wrapper });
  await waitFor(() => expect(first.result.current.data).toEqual(providers));
  renderHook(() => useProviders(), { wrapper });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(queryKeys.providers.list())).toEqual(providers);
  expect(client.getQueryState(queryKeys.providers.list())?.isInvalidated).toBe(false);
});
