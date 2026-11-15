// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("./client", () => ({
  apiClient: { trashSettings: mocks.get, systemUpdateTrash: mocks.put },
}));

import { useTrashSettings, useUpdateTrashSettings } from "./trash-settings-queries";

it("reads how long Trash keeps an item and keeps what an administrator saves", async () => {
  mocks.get.mockResolvedValue({ retentionDays: 30 });
  mocks.put.mockResolvedValue({ retentionDays: 7 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const query = renderHook(() => useTrashSettings(), { wrapper });
  await waitFor(() => expect(query.result.current.data).toEqual({ retentionDays: 30 }));
  const mutation = renderHook(() => useUpdateTrashSettings(), { wrapper });
  await act(async () => {
    await mutation.result.current.mutateAsync({ retentionDays: 7 });
  });
  expect(mocks.put).toHaveBeenCalledWith({ retentionDays: 7 });
  expect(client.getQueryData(["trash", "settings"])).toEqual({ retentionDays: 7 });
  client.clear();
});
