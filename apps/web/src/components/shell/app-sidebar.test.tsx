// @vitest-environment jsdom

import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { apiClient } from "@/lib/api/client";
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

// The About sheet asks the API for the server's version when it opens; its own test covers that.
vi.mock("@/components/about/about-dialog", () => ({
  AboutDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="About fdrive" /> : null,
}));

const ada: MeResponse["identity"] = makeIdentity();

const me = makeMe({ identity: ada });

/** What the administrator's System row polls for: nothing running in any area. */
const IDLE = { observedAt: new Date().toISOString(), items: [] };

function renderSidebar(account: MeResponse = me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], account);
  client.setQueryData(["favorites", "list"], []);
  client.setQueryData(["recents", "list"], []);
  client.setQueryData(["tags", "list"], []);
  client.setQueryData(["saved-searches", "list"], []);
  client.setQueryData(["grants", "list"], { owned: [], received: [] });
  client.setQueryData(["system", "activity"], IDLE);
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
  vi.spyOn(apiClient, "systemActivity").mockResolvedValue(IDLE);
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

it("opens Settings from the account menu, beside Appearance, Storage and About", async () => {
  renderSidebar();
  fireEvent.click(await screen.findByRole("button", { name: /ada/ }));

  const settings = await screen.findByRole("menuitem", { name: "Settings" });
  // Settings keeps the URL it had while the page was called Account.
  expect(settings.getAttribute("href")).toBe("/account");
  expect(screen.queryByRole("menuitem", { name: "Account" })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Appearance" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Storage" }).getAttribute("href")).toBe("/storage");
  expect(screen.getByRole("menuitem", { name: "About" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
});

it("opens About as a sheet over the page for someone who is not an administrator", async () => {
  renderSidebar();
  fireEvent.click(await screen.findByRole("button", { name: /ada/ }));
  expect(screen.queryByRole("dialog", { name: "About fdrive" })).toBeNull();

  const about = await screen.findByRole("menuitem", { name: "About" });
  // Not a link: there is no page to go to, the sheet opens where they are.
  expect(about.getAttribute("href")).toBeNull();
  fireEvent.click(about);

  expect(await screen.findByRole("dialog", { name: "About fdrive" })).toBeTruthy();
});

it("links an administrator's About to the last System area instead of opening the sheet", async () => {
  renderSidebar({ ...me, isAdmin: true });
  fireEvent.click(await screen.findByRole("button", { name: /ada/ }));

  // A link to a page of its own, where the other one is a button that opens the sheet.
  const about = await screen.findByRole("menuitem", { name: "About" });
  expect(about.tagName).toBe("A");
  expect(about.getAttribute("href")).toBe("/system/about");
  expect(screen.queryByRole("dialog", { name: "About fdrive" })).toBeNull();
});

it("closes from its own header button, beside the wordmark", async () => {
  const { container } = renderSidebar();
  const sidebar = container.querySelector('[data-slot="sidebar"]');
  expect(sidebar?.getAttribute("data-state")).toBe("expanded");

  fireEvent.click(await screen.findByRole("button", { name: "Close sidebar" }));
  expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
});

it("gives an administrator one System row, with its areas left to the System page", async () => {
  renderSidebar({ ...me, isAdmin: true });

  const system = await screen.findByRole("link", { name: "System" });
  expect(system.getAttribute("href")).toBe("/system");
  // Last in the navigation, after Trash.
  expect(isBefore(screen.getByRole("link", { name: "Trash" }), system)).toBe(true);
  for (const area of ["General", "Users", "Features", "Thumbnails", "Full-text search", "Office"]) {
    expect(screen.queryByRole("link", { name: area })).toBeNull();
  }
  expect(screen.queryByRole("link", { name: "Storage" })).toBeNull();
});

it("hides System from a non-admin", async () => {
  renderSidebar();
  await screen.findByRole("link", { name: "Shares" });

  expect(screen.queryByRole("link", { name: "System" })).toBeNull();
  expect(screen.queryByRole("link", { name: "General" })).toBeNull();
});
