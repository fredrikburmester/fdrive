// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("./client", () => ({
  apiClient: { systemOffice: mocks.get, systemUpdateOffice: mocks.put },
}));

import { useSystemOffice, useUpdateOfficeSettings } from "./office-settings-queries";

it("loads settings and refreshes editor capabilities after saving", async () => {
  const configuration = {
    revision: 0,
    enabled: false,
    appUrl: null,
    editingProviderId: null,
    editorUsernames: [],
    editingEnabled: false,
  };
  const data = { configuration, product: "onlyoffice", status: "off" };
  const changed = { ...configuration, enabled: true, appUrl: "http://localhost:8090" };
  const updated = { ...data, configuration: { ...changed, revision: 1 }, status: "starting" };
  mocks.get.mockResolvedValue(data);
  mocks.put.mockResolvedValue(updated);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const query = renderHook(() => useSystemOffice(), { wrapper });
  await waitFor(() => expect(query.result.current.data).toEqual(data));
  const mutation = renderHook(() => useUpdateOfficeSettings(), { wrapper });
  await act(async () => {
    await mutation.result.current.mutateAsync(changed);
  });
  expect(mocks.put).toHaveBeenCalledWith(changed);
  expect(client.getQueryData(["system", "office"])).toEqual(updated);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["office"] });
  query.unmount();
  mutation.unmount();
  client.clear();
});
