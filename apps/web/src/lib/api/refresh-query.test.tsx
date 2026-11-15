// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { refreshQuery } from "./refresh-query";

const queryKey = ["fs", "list", "/"];
afterEach(cleanup);

it("replaces an initial request with no cached data and discards its late response", async () => {
  const stale = Promise.withResolvers<string[]>();
  const query = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(["uploaded.txt"]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useQuery({ queryKey, queryFn: query }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  expect(result.current.data).toBeUndefined();
  await act(async () => {
    await refreshQuery(client, queryKey);
  });
  await waitFor(() => expect(result.current.data).toEqual(["uploaded.txt"]));
  expect(query).toHaveBeenCalledTimes(2);
  await act(async () => {
    stale.resolve([]);
    await stale.promise;
  });
  expect(result.current.data).toEqual(["uploaded.txt"]);
});

it("cancels before it invalidates the same key", async () => {
  const client = new QueryClient();
  const calls: string[] = [];
  vi.spyOn(client, "cancelQueries").mockImplementation(async () => {
    calls.push("cancel");
  });
  vi.spyOn(client, "invalidateQueries").mockImplementation(async () => {
    calls.push("invalidate");
  });
  await refreshQuery(client, queryKey);
  expect(calls).toEqual(["cancel", "invalidate"]);
  expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey });
  expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey });
});
