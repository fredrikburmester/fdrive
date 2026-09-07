// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { apiClient } from "@/lib/api/client";
import { RecentsSection } from "./recents-section";

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

it("renders nothing while the recents query is still loading", () => {
  vi.spyOn(apiClient, "listRecents").mockReturnValue(new Promise(() => {}));
  const client = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <RecentsSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(container.textContent).toBe("");
});

it("shows a muted placeholder instead of disappearing when nothing was opened yet", async () => {
  vi.spyOn(apiClient, "listRecents").mockResolvedValue({ items: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <RecentsSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Recents")).toBeDefined();
  expect(await screen.findByText("Files you open show up here")).toBeDefined();
  expect(screen.queryByText("Show all")).toBeNull();
});

it("renders every recent file plus a Show all link once loaded", async () => {
  vi.spyOn(apiClient, "listRecents").mockResolvedValue({
    items: [{ path: "/notes.md", openedAt: "2026-01-01T00:00:00Z" }],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <RecentsSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("notes.md")).toBeDefined();
  expect(screen.getByText("Show all")).toBeDefined();
  expect(screen.queryByText("Files you open show up here")).toBeNull();
});
