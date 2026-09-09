// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("./client", () => ({
  apiClient: { systemPublicUrl: mocks.get, systemUpdatePublicUrl: mocks.put },
}));

import { useSystemPublicUrl, useUpdatePublicUrl } from "./public-url-queries";

it("loads the address and refreshes Office status after saving it", async () => {
  const data = { revision: 0, url: null };
  const changed = { revision: 0, url: "http://localhost:8090" };
  const updated = { revision: 1, url: "http://localhost:8090" };
  mocks.get.mockResolvedValue(data);
  mocks.put.mockResolvedValue(updated);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const query = renderHook(() => useSystemPublicUrl(), { wrapper });
  await waitFor(() => expect(query.result.current.data).toEqual(data));
  const mutation = renderHook(() => useUpdatePublicUrl(), { wrapper });
  await act(async () => {
    await mutation.result.current.mutateAsync(changed);
  });
  expect(mocks.put).toHaveBeenCalledWith(changed);
  expect(client.getQueryData(["system", "public-url"])).toEqual(updated);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["system", "office"] });
  query.unmount();
  mutation.unmount();
  client.clear();
});
