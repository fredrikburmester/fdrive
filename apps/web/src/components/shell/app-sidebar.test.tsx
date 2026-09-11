// @vitest-environment jsdom

import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
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

const ada: MeResponse["identities"][number] = makeIdentity({ capabilities: { trash: true } });

const me = makeMe({
  identities: [ada],
  activeIdentityId: "one",
});

/** `me` with its only login's capabilities overridden. */
function withCapabilities(overrides: Partial<MeResponse["identities"][number]["capabilities"]>) {
  return {
    ...me,
    identities: [{ ...ada, capabilities: { ...ada.capabilities, ...overrides } }],
  };
}

function renderSidebar(account: MeResponse = me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], account);
  client.setQueryData(["trash", "status"], {
    available: true,
    path: "/.trash",
    retentionHours: null,
  });
  client.setQueryData(["favorites", "list"], []);
  client.setQueryData(["recents", "list"], []);
  client.setQueryData(["tags", "list"], []);
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
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

it("hides Trash when no linked login has one", async () => {
  renderSidebar(withCapabilities({ trash: false }));
  await screen.findByRole("link", { name: "Shares" });
  expect(screen.queryByRole("link", { name: "Trash" })).toBeNull();
});

it("hides Shares when no linked login can share", async () => {
  renderSidebar(withCapabilities({ shares: false }));
  await screen.findByRole("link", { name: "Files" });
  expect(screen.queryByRole("link", { name: "Shares" })).toBeNull();
});

it("shows Shares and Trash when any linked login has them, and names each login's provider type", async () => {
  renderSidebar({
    ...me,
    identities: [
      { ...ada, capabilities: { ...ada.capabilities, shares: false, trash: false } },
      {
        ...ada,
        id: "two",
        username: "bob",
        providerLabel: "Other",
        capabilities: { ...ada.capabilities, trash: true, shares: true },
      },
    ],
  });
  await screen.findByRole("link", { name: "Shares" });
  expect(screen.getByRole("link", { name: "Trash" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "SFTPGo" })).toBeTruthy();
});

it("applies tighter vertical nav item spacing via scoped descendant styles on SidebarContent", () => {
  const { container } = renderSidebar();
  const content = container.querySelector('[data-slot="sidebar-content"]');
  expect(content?.className).toContain("gap-0");
  expect(content?.className).toContain("[&_[data-sidebar=group]]:py-1");
  expect(content?.className).toContain("[&_[data-sidebar=group-label]]:h-7");
  expect(content?.className).toContain("[&_[data-sidebar=menu]]:gap-0");
});

it("lists the System pages in order, each as its own menu item", async () => {
  renderSidebar({ ...me, isAdmin: true });

  const expected = [
    ["Features", "/system/features"],
    ["General", "/system/general"],
    ["Storage", "/system/storage"],
    ["Shared folders", "/system/shared-folders"],
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
  for (const [index, link] of links.entries()) {
    expect(link.getAttribute("href")).toBe(expected[index]?.[1]);
    expect(link.closest("li")).not.toBeNull();
    if (index > 0) {
      const previous = links[index - 1];
      expect(previous !== undefined && isBefore(previous, link)).toBe(true);
    }
  }
  expect(screen.queryByRole("link", { name: "Connection" })).toBeNull();
});

it("hides the System group from a non-admin", async () => {
  renderSidebar();
  await screen.findByRole("link", { name: "Shares" });

  expect(screen.queryByRole("link", { name: "Features" })).toBeNull();
  expect(screen.queryByRole("link", { name: "General" })).toBeNull();
});
