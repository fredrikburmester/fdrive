// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
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

const me: MeResponse = {
  account: { id: "a", displayName: "Ada" },
  identities: [{ id: "one", username: "ada", providerType: "sftpgo", providerLabel: "Main" }],
  activeIdentityId: "one",
  isAdmin: false,
};

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], me);
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

it("hides Trash when the provider has none", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], me);
  client.setQueryData(["trash", "status"], { available: false, path: null, retentionHours: null });
  client.setQueryData(["favorites", "list"], []);
  client.setQueryData(["recents", "list"], []);
  client.setQueryData(["tags", "list"], []);
  render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("link", { name: "Shares" });
  expect(screen.queryByRole("link", { name: "Trash" })).toBeNull();
});

it("applies tighter vertical nav item spacing via scoped descendant styles on SidebarContent", () => {
  const { container } = renderSidebar();
  const content = container.querySelector('[data-slot="sidebar-content"]');
  expect(content?.className).toContain("gap-0");
  expect(content?.className).toContain("[&_[data-sidebar=group]]:py-1");
  expect(content?.className).toContain("[&_[data-sidebar=group-label]]:h-7");
  expect(content?.className).toContain("[&_[data-sidebar=menu]]:gap-0");
});
