// @vitest-environment jsdom

import type { MeResponse, SavedSearch } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { SearchShortcutProvider, useSearchShortcut } from "@/lib/search/shortcut";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";
import { SearchButton } from "./search-button";

const navigation = vi.hoisted(() => ({ pathname: "/files" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => navigation.pathname,
}));

const singleIdentityMe = makeMe({ identity: makeIdentity() });

const invoices: SavedSearch = {
  id: "s1",
  name: "Invoices",
  query: "invoice",
  type: "any",
  folder: null,
};

/** Stands in for the sidebar's saved searches, which open the panel through the same context. */
function SavedSearchLink() {
  const { openSaved } = useSearchShortcut();
  return (
    <button type="button" onClick={() => openSaved(invoices)}>
      Invoices
    </button>
  );
}

function renderButton(me: MeResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], me);
  return render(
    <QueryClientProvider client={client}>
      <SearchShortcutProvider>
        <SavedSearchLink />
        <SearchButton />
      </SearchShortcutProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  navigation.pathname = "/files";
  // `SearchPanel` (rendered by `SearchButton`) calls `useIsMobile`, which
  // reads `window.matchMedia`; jsdom does not implement it.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stays enabled and opens the panel even when the search index is unavailable", async () => {
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: false,
    semantic: false,
    images: false,
  });
  renderButton(singleIdentityMe);
  const button = await screen.findByRole("button", { name: "Search" });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  expect(await screen.findByRole("dialog")).toBeDefined();
});

it("stays enabled and opens the panel when the index is available", async () => {
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: false,
  });
  renderButton(singleIdentityMe);
  const button = await screen.findByRole("button", { name: "Search" });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  expect(await screen.findByRole("dialog")).toBeDefined();
});

it("shows the button in a folder below /files", async () => {
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: false,
  });
  navigation.pathname = "/files/docs/reports";
  renderButton(singleIdentityMe);
  expect(await screen.findByRole("button", { name: "Search" })).toBeDefined();
});

it.each(["/trash", "/shares", "/activity", "/photos", "/system/general"])(
  "hides the button on %s, where Cmd+K still opens the panel",
  async (pathname) => {
    vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
      available: true,
      semantic: true,
      images: false,
    });
    navigation.pathname = pathname;
    renderButton(singleIdentityMe);
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  },
);

it("opens a saved search from a page without the button", async () => {
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({
    available: true,
    semantic: true,
    images: false,
  });
  vi.spyOn(apiClient, "search").mockResolvedValue({
    query: "invoice",
    sections: { folders: [], files: [], content: [] },
    degraded: false,
    unavailable: false,
    partial: false,
    tookMs: 1,
  });
  navigation.pathname = "/trash";
  renderButton(singleIdentityMe);

  fireEvent.click(screen.getByRole("button", { name: "Invoices" }));
  expect(await screen.findByRole("dialog")).toBeDefined();
  expect(await screen.findByDisplayValue("invoice")).toBeDefined();
});
