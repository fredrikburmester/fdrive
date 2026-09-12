// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("./client", () => ({
  apiClient: { systemTrash: mocks.get, systemUpdateTrash: mocks.put },
}));

import { useSystemTrash, useUpdateTrashSettings } from "./trash-settings-queries";

it("loads settings and refreshes affected views after a live change", async () => {
  const data = {
    providerId: "provider",
    revision: 0,
    enabled: false,
    path: "/.trash",
    retentionHours: null,
    rulesConfirmed: false,
    strategy: "native" as const,
  };
  const updated = { ...data, revision: 1, enabled: true, rulesConfirmed: true };
  mocks.get.mockResolvedValue(data);
  mocks.put.mockResolvedValue(updated);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const query = renderHook(() => useSystemTrash(), { wrapper });
  await waitFor(() => expect(query.result.current.data).toEqual(data));
  const mutation = renderHook(() => useUpdateTrashSettings(), { wrapper });
  await act(async () => {
    await mutation.result.current.mutateAsync(updated);
  });
  expect(mocks.put).toHaveBeenCalledWith(updated);
  expect(client.getQueryData(["system", "trash"])).toEqual(updated);
  for (const key of ["trash", "fs", "search"])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
  client.clear();
});
