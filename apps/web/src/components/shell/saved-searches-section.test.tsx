// @vitest-environment jsdom
import type { SavedSearch } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { apiClient } from "@/lib/api/client";
import { SearchShortcutProvider, useSearchShortcut } from "@/lib/search/shortcut";
import { SavedSearchesSection } from "./saved-searches-section";

const INVOICES: SavedSearch = {
  id: "s1",
  name: "Invoices",
  query: "invoice",
  type: "documents",
  folder: "/Work",
};

function PanelState() {
  const { open, saved } = useSearchShortcut();
  return <output>{open ? `Searching ${saved?.query}` : "Closed"}</output>;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchShortcutProvider>
        <SidebarProvider>
          <SavedSearchesSection />
        </SidebarProvider>
        <PanelState />
      </SearchShortcutProvider>
    </QueryClientProvider>,
  );
}

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
  window.localStorage.clear();
});

it("shows a muted placeholder while there are no saved searches", async () => {
  vi.spyOn(apiClient, "listSavedSearches").mockResolvedValue({ searches: [] });
  renderSection();
  expect(await screen.findByText("Save a search to see it here")).toBeDefined();
});

it("opens the search panel on a saved search and removes one from its context menu", async () => {
  vi.spyOn(apiClient, "listSavedSearches").mockResolvedValue({ searches: [INVOICES] });
  const remove = vi.spyOn(apiClient, "deleteSavedSearch").mockResolvedValue({ ok: true });
  renderSection();

  fireEvent.click(await screen.findByRole("button", { name: "Invoices" }));
  expect(screen.getByText("Searching invoice")).toBeDefined();

  fireEvent.contextMenu(screen.getByRole("button", { name: "Invoices" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("s1"));
});

it("remembers when the section is collapsed", async () => {
  vi.spyOn(apiClient, "listSavedSearches").mockResolvedValue({ searches: [INVOICES] });
  renderSection();
  fireEvent.click(await screen.findByText("Saved searches"));
  expect(window.localStorage.getItem("fdrive.sidebar.section.savedSearches")).toBe("false");
});
