// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSystemActivity } from "./activity-queries";
import { apiClient } from "./client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const empty = () => ({ observedAt: new Date().toISOString(), items: [] });
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const hook = renderHook(() => useSystemActivity(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, ...hook };
}

it("shows a local save only while pending and ignores unrelated mutations", async () => {
  vi.spyOn(apiClient, "systemActivity").mockImplementation(async () => empty());
  const { client, result } = mount();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  let finish = () => {};
  const mutation = client.getMutationCache().build(client, {
    meta: { systemActivity: ["storage"] },
    mutationFn: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  let pending: Promise<void> = Promise.resolve();
  act(() => {
    pending = mutation.execute(undefined);
  });
  await waitFor(() => expect(result.current.pending.has("storage")).toBe(true));
  await act(async () => {
    finish();
    await pending;
  });
  await waitFor(() => expect(result.current.pending.has("storage")).toBe(false));
  const unrelated = client.getMutationCache().build(client, { mutationFn: async () => {} });
  await act(async () => {
    await unrelated.execute(undefined);
  });
  expect(result.current.pending.size).toBe(0);
});

it("bridges accepted jobs to server activity and drops optimistic state when polling fails", async () => {
  const fetch = vi.spyOn(apiClient, "systemActivity").mockImplementation(async () => empty());
  const { client, result } = mount();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const mutation = client.getMutationCache().build(client, {
    meta: { systemActivity: ["thumbnails"], systemActivityBackground: true },
    mutationFn: async () => ({}),
  });
  await act(async () => {
    await mutation.execute(undefined);
  });
  await waitFor(() => expect(result.current.pending.has("thumbnails")).toBe(true));
  fetch.mockResolvedValue({
    observedAt: new Date().toISOString(),
    items: [
      {
        id: "thumbnails",
        state: "working",
        percent: 50,
        warning: false,
        detail: "50 of 100",
        operationIds: ["new-job"],
      },
    ],
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["system", "activity"] });
  });
  await waitFor(() => expect(result.current.pending.has("thumbnails")).toBe(false));
  expect(result.current.data?.items[0]?.percent).toBe(50);
  fetch.mockRejectedValue(new Error("offline"));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["system", "activity"] });
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.pending.size).toBe(0);
});
