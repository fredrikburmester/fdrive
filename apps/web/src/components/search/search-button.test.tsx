// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { SearchShortcutProvider } from "@/lib/search/shortcut";
import { SearchButton } from "./search-button";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/files",
}));

const singleIdentityMe: MeResponse = {
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

function renderButton(me: MeResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], me);
  return render(
    <QueryClientProvider client={client}>
      <SearchShortcutProvider>
        <SearchButton />
      </SearchShortcutProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
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
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({ available: false, semantic: false });
  renderButton(singleIdentityMe);
  const button = await screen.findByRole("button", { name: "Search" });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  expect(await screen.findByRole("dialog")).toBeDefined();
});

it("stays enabled and opens the panel when the index is available", async () => {
  vi.spyOn(apiClient, "searchStatus").mockResolvedValue({ available: true, semantic: true });
  renderButton(singleIdentityMe);
  const button = await screen.findByRole("button", { name: "Search" });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  expect(await screen.findByRole("dialog")).toBeDefined();
});
