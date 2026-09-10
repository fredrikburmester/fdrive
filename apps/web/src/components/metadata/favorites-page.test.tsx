// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { FavoritesPage } from "./favorites-page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/shell/page-header", async () => {
  const { useMe } = await import("@/lib/api/auth-queries");
  return { useShellMe: useMe, PageHeader: () => <span>Favorites</span> };
});
const me: MeResponse = {
  account: { id: "a", displayName: "Ada" },
  identities: [
    {
      id: "one",
      username: "ada",
      providerType: "sftpgo",
      providerLabel: "Main",
      providerId: "00000000-0000-4000-8000-000000000009",
      capabilities: {
        zip: true,
        setModifiedAt: true,
        atomicMove: true,
        trash: false,
        shares: true,
        office: true,
        index: true,
        scopeMapping: true,
      },
    },
  ],
  activeIdentityId: "one",
  isAdmin: false,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  push.mockClear();
});
it("opens owned files using safe paths and reports stale unlinked identities", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  vi.spyOn(apiClient, "accountFavorites").mockResolvedValue({
    items: [
      { identityId: "one", path: "/a #.txt", kind: "file", addedAt: "2026-01-01T00:00:00Z" },
      { identityId: "removed", path: "/old.txt", kind: "file", addedAt: "2026-01-01T00:00:00Z" },
    ],
    unavailableIdentityIds: [],
  });
  render(
    <QueryClientProvider client={client}>
      <FavoritesPage />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "a #.txt" })).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "a #.txt" }));
  expect(push).toHaveBeenCalledWith("/view/a%20%23.txt");
  fireEvent.click(screen.getByRole("button", { name: "old.txt" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no longer linked"));
  expect(push).toHaveBeenCalledTimes(1);
});
it("shows a read error without fabricating empty favorites", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["auth", "me"], me);
  vi.spyOn(apiClient, "accountFavorites").mockRejectedValue(new Error("Unavailable"));
  render(
    <QueryClientProvider client={client}>
      <FavoritesPage />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Unavailable"));
  expect(screen.queryByText("No favorites available.")).toBeNull();
});
