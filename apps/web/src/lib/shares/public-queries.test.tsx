// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  publicShareKey,
  publicShareMetadataKey,
  usePublicShare,
  useShareEntries,
} from "./public-queries";

const requests = vi.hoisted(() => ({
  metadata: vi.fn().mockResolvedValue({ name: "Public" }),
  entries: vi.fn().mockResolvedValue({ items: [] }),
  signals: [] as (AbortSignal | undefined)[],
}));
vi.mock("./client", () => ({
  publicShareClient: (signal?: AbortSignal) => {
    requests.signals.push(signal);
    return { publicShare: requests.metadata, shareEntries: requests.entries };
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  requests.signals.length = 0;
});
it("separates credentials and relative paths in protected keys and aborts removed queries", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const metadata = renderHook(() => usePublicShare("id", 0), { wrapper });
  const entries = renderHook(
    ({ enabled, generation }) => useShareEntries("id", "/日本%", generation, enabled),
    { wrapper, initialProps: { enabled: false, generation: 0 } },
  );
  await waitFor(() => expect(metadata.result.current.isSuccess).toBe(true));
  expect(requests.entries).not.toHaveBeenCalled();
  entries.rerender({ enabled: true, generation: 0 });
  await waitFor(() => expect(entries.result.current.isSuccess).toBe(true));
  expect(requests.entries).toHaveBeenCalledWith("id", "/日本%");
  expect(queryClient.getQueryData(["public-share", "id", 0, "entries", "/日本%"])).toEqual({
    items: [],
  });
  requests.entries.mockImplementationOnce(() => new Promise(() => {}));
  entries.rerender({ enabled: true, generation: 1 });
  await waitFor(() => expect(requests.entries).toHaveBeenCalledTimes(2));
  const lastSignal = requests.signals.at(-1);
  await queryClient.cancelQueries({ queryKey: publicShareKey("id") });
  queryClient.removeQueries({ queryKey: publicShareKey("id") });
  expect(lastSignal?.aborted).toBe(true);
  expect(publicShareMetadataKey("id", 1)).toEqual(["public-share", "id", 1, "metadata"]);
});
