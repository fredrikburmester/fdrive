// @vitest-environment jsdom
import type { BackupsResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { backupClient, backupQueryKey, useBackups } from "./backup-queries";

it("refreshes the backup overview after owner actions invalidate it", async () => {
  const data: BackupsResponse = {
    enabled: true,
    owner: true,
    installationId: "installation",
    recipient: null,
    keyConfirmed: false,
    schedule: { frequency: "manual", timezone: "UTC", hour: 3, daily: 7, weekly: 4, monthly: 12 },
    nextRunAt: null,
    restored: false,
    destinations: [],
    attachments: [],
    runs: [],
  };
  const status = vi.spyOn(backupClient, "status").mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useBackups(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    await waitFor(() => expect(hook.result.current.data?.keyConfirmed).toBe(false));
    status.mockResolvedValue({ ...data, keyConfirmed: true });
    await act(() => client.invalidateQueries({ queryKey: backupQueryKey }));
    await waitFor(() => expect(hook.result.current.data?.keyConfirmed).toBe(true));
    expect(status).toHaveBeenCalledTimes(2);
  } finally {
    hook.unmount();
    client.clear();
    status.mockRestore();
  }
});
