// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { apiClient } from "@/lib/api/client";
import { FavoritesSection } from "./favorites-section";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders nothing while the favorites query is still loading", () => {
  vi.spyOn(apiClient, "listFavorites").mockReturnValue(new Promise(() => {}));
  const client = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <FavoritesSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(container.textContent).toBe("");
});

it("shows a muted placeholder instead of disappearing when there are no favorites", async () => {
  vi.spyOn(apiClient, "listFavorites").mockResolvedValue({ items: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <FavoritesSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Favorites")).toBeDefined();
  expect(await screen.findByText("Star a file to see it here")).toBeDefined();
});

it("renders every favorite as a link once loaded", async () => {
  vi.spyOn(apiClient, "listFavorites").mockResolvedValue({
    items: [{ path: "/report.pdf", kind: "file", addedAt: "2026-01-01T00:00:00Z" }],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <FavoritesSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("report.pdf")).toBeDefined();
  expect(screen.queryByText("Star a file to see it here")).toBeNull();
});
