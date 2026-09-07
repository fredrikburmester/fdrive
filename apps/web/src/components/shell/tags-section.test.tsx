// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { apiClient } from "@/lib/api/client";
import { TagsSection } from "./tags-section";

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

it("renders nothing while the tags query is still loading", () => {
  vi.spyOn(apiClient, "listTags").mockReturnValue(new Promise(() => {}));
  const client = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <TagsSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(container.textContent).toBe("");
});

it("always shows Manage tags, with a muted placeholder when the account has no tags yet", async () => {
  vi.spyOn(apiClient, "listTags").mockResolvedValue({ tags: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <TagsSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("No tags yet")).toBeDefined();
  expect(screen.getByText("Manage tags…")).toBeDefined();
});

it("renders every tag plus Manage tags once loaded", async () => {
  vi.spyOn(apiClient, "listTags").mockResolvedValue({
    tags: [{ id: "t1", name: "Invoices", color: "blue" }],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <TagsSection />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Invoices")).toBeDefined();
  expect(screen.getByText("Manage tags…")).toBeDefined();
  expect(screen.queryByText("No tags yet")).toBeNull();
});
