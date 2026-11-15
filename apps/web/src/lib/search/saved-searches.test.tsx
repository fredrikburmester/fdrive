// @vitest-environment jsdom
import type { CreateSavedSearchRequest } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { useSavedSearches, useSavedSearchMutations } from "./saved-searches";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const REQUEST: CreateSavedSearchRequest = {
  name: "Invoices",
  query: "invoice",
  type: "documents",
  folder: null,
};
const SAVED = { id: "s1", ...REQUEST };

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  return {
    invalidate,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  toastError.mockReset();
});

it("lists the account's saved searches", async () => {
  vi.spyOn(apiClient, "listSavedSearches").mockResolvedValue({ searches: [SAVED] });
  const { result } = renderHook(() => useSavedSearches(), wrapper());
  await waitFor(() => expect(result.current.data).toEqual([SAVED]));
});

it("saves and removes a search, refreshing the list after each", async () => {
  const create = vi.spyOn(apiClient, "createSavedSearch").mockResolvedValue(SAVED);
  const remove = vi.spyOn(apiClient, "deleteSavedSearch").mockResolvedValue({ ok: true });
  const { invalidate, ...options } = wrapper();
  const { result } = renderHook(() => useSavedSearchMutations(), options);

  await result.current.create.mutateAsync(REQUEST);
  await result.current.remove.mutateAsync("s1");

  expect(create).toHaveBeenCalledWith(REQUEST);
  expect(remove).toHaveBeenCalledWith("s1");
  expect(invalidate).toHaveBeenCalledTimes(2);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["saved-searches", "list"] });
});

it("says so when saving or removing fails", async () => {
  vi.spyOn(apiClient, "createSavedSearch").mockRejectedValue(new Error("boom"));
  vi.spyOn(apiClient, "deleteSavedSearch").mockRejectedValue(new Error("boom"));
  const { result } = renderHook(() => useSavedSearchMutations(), wrapper());

  result.current.create.mutate(REQUEST);
  result.current.remove.mutate("s1");

  await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
  expect(toastError).toHaveBeenCalledWith("Could not save the search.");
  expect(toastError).toHaveBeenCalledWith("Could not remove the saved search.");
});
