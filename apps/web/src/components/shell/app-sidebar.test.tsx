// @vitest-environment jsdom

import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SearchShortcutProvider } from "@/lib/search/shortcut";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";
import { AppSidebar } from "./app-sidebar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/files",
}));

// `FolderTree` needs a real `fs.list("/")` query and drag-and-drop wiring
// this test does not exercise; stubbed with a single "Files" link so the
// "Locations" group's order (Files tree, Shares, Trash) is still visible
// without pulling in every one of the tree's own dependencies.
vi.mock("@/components/shell/folder-tree", () => ({
  FolderTree: () => (
    <li>
      <a href="/files">Files</a>
    </li>
  ),
}));

const ada: MeResponse["identity"] = makeIdentity();

const me = makeMe({ identity: ada });

function renderSidebar(account: MeResponse = me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], account);
  client.setQueryData(["favorites", "list"], []);
  client.setQueryData(["recents", "list"], []);
  client.setQueryData(["tags", "list"], []);
  client.setQueryData(["saved-searches", "list"], []);
  client.setQueryData(["grants", "list"], { owned: [], received: [] });
  return render(
    <QueryClientProvider client={client}>
      <SearchShortcutProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
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
});

/** True when `before` appears earlier in the document than `after`. */
function isBefore(before: Element, after: Element): boolean {
  return (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

it("orders navigation as Files tree, metadata sections, then Shares and Trash at the bottom", async () => {
  renderSidebar();
  const filesLink = await screen.findByRole("link", { name: "Files" });
  const manageTags = await screen.findByRole("button", { name: /Manage tags/ });
  const sharesLink = screen.getByRole("link", { name: "Shares" });
  const trashLink = screen.getByRole("link", { name: "Trash" });

  expect(isBefore(filesLink, manageTags)).toBe(true);
  expect(isBefore(manageTags, sharesLink)).toBe(true);
  expect(isBefore(sharesLink, trashLink)).toBe(true);
});

it("links Photos above My activity", async () => {
  renderSidebar();
  const photos = await screen.findByRole("link", { name: "Photos" });
  expect(photos.getAttribute("href")).toBe("/photos");
  expect(isBefore(photos, screen.getByRole("link", { name: "My activity" }))).toBe(true);
});

it("links the fdrive wordmark to the root of Files", async () => {
  renderSidebar();
  const wordmark = await screen.findByRole("link", { name: "fdrive" });
  expect(wordmark.getAttribute("href")).toBe("/files");
});

it("always shows Trash, and names the signed-in login and its storage", async () => {
  renderSidebar();
  await screen.findByRole("link", { name: "Shares" });
  expect(screen.getByRole("link", { name: "Trash" })).toBeTruthy();
  expect(screen.getByText("ada")).toBeTruthy();
  expect(screen.getByText("Main")).toBeTruthy();
});

it("applies tighter vertical nav item spacing via scoped descendant styles on SidebarContent", () => {
  const { container } = renderSidebar();
  const content = container.querySelector('[data-slot="sidebar-content"]');
  expect(content?.className).toContain("gap-0");
  expect(content?.className).toContain("[&_[data-sidebar=group]]:py-1");
  expect(content?.className).toContain("[&_[data-sidebar=group-label]]:h-7");
  expect(content?.className).toContain("[&_[data-sidebar=menu]]:gap-0");
});

it("nests feature pages beneath Features and keeps other System pages separate", async () => {
  renderSidebar({ ...me, isAdmin: true });

  const expected = [
    ["General", "/system/general"],
    ["Users", "/system/users"],
    ["Features", "/system/features"],
    ["Thumbnails", "/system/thumbnails"],
    ["Full-text search", "/system/indexer"],
    ["Semantic search", "/system/search"],
    ["Searchable PDFs", "/system/ocr"],
    ["Image search", "/system/image-search"],
    ["Office", "/system/office"],
  ] as const;

  const links = await Promise.all(
    expected.map(([label]) => screen.findByRole("link", { name: label })),
  );
  const featuresItem = links[2]?.closest("li");
  for (const [index, link] of links.entries()) {
    expect(link.getAttribute("href")).toBe(expected[index]?.[1]);
    expect(link.closest("li")).not.toBeNull();
    expect(featuresItem?.contains(link)).toBe(index >= 2);
    if (index > 0) {
      const previous = links[index - 1];
      expect(previous !== undefined && isBefore(previous, link)).toBe(true);
    }
  }
  expect(screen.queryByRole("link", { name: "Connection" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Storage" })).toBeNull();
  expect(screen.getByText("Admins only")).toBeTruthy();
});

it("hides the System group from a non-admin", async () => {
  renderSidebar();
  await screen.findByRole("link", { name: "Shares" });

  expect(screen.queryByRole("link", { name: "Features" })).toBeNull();
  expect(screen.queryByRole("link", { name: "General" })).toBeNull();
  expect(screen.queryByText("Admins only")).toBeNull();
});
