// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { refreshIdentityQuery } from "./invalidation";
import { createAccountTransitionStore } from "./transition";

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
    await refreshIdentityQuery(client, queryKey, createAccountTransitionStore());
  });
  await waitFor(() => expect(result.current.data).toEqual(["uploaded.txt"]));
  expect(query).toHaveBeenCalledTimes(2);
  await act(async () => {
    stale.resolve([]);
    await stale.promise;
  });
  expect(result.current.data).toEqual(["uploaded.txt"]);
});

it("does nothing while an identity transition is pending", async () => {
  const client = new QueryClient();
  const cancel = vi.spyOn(client, "cancelQueries");
  const transition = createAccountTransitionStore();
  transition.begin();
  await refreshIdentityQuery(client, queryKey, transition);
  expect(cancel).not.toHaveBeenCalled();
});

it.each([false, true])(
  "never refetches a new or pending login after cancellation awaits: changed=%s",
  async (changed) => {
    const client = new QueryClient();
    const cancelled = Promise.withResolvers<void>();
    vi.spyOn(client, "cancelQueries").mockReturnValue(cancelled.promise);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const transition = createAccountTransitionStore();
    const request = refreshIdentityQuery(client, queryKey, transition);
    transition.begin();
    if (changed) transition.finish(true);
    client.setQueryData(queryKey, ["new identity.txt"]);
    cancelled.resolve();
    await request;
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKey)).toEqual(["new identity.txt"]);
  },
);
