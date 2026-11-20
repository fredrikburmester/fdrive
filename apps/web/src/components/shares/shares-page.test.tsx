// @vitest-environment jsdom
import type { ManagedShare } from "@fdrive/contracts";
import { ApiClientError } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharesPage } from "./shares-page";

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  revoke: vi.fn(),
  entries: vi.fn(),
  gesture: vi.fn(),
}));
vi.mock("@/lib/shares/management", () => ({
  useShareManagement: () => ({
    query: mocks.query,
    create: vi.fn(),
    update: vi.fn(),
    revoke: mocks.revoke,
    entries: mocks.entries,
  }),
}));
vi.mock("@/lib/activity/gestures", () => ({
  activityGesture: (...args: unknown[]) => {
    mocks.gesture(...args);
    return () => Promise.resolve();
  },
}));
vi.mock("@/components/grants/shared-with-people-section", () => ({
  SharedWithPeopleSection: () => <section aria-label="Shared with people" />,
}));
vi.mock("./share-dialog", () => ({
  ShareDialog: ({ share }: { share: ManagedShare }) => (
    <div role="dialog" aria-label={`Edit ${share.name}`} />
  ),
}));
// The shell header needs the sidebar context and search wiring this page test does not exercise.
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => <header /> }));

const share: ManagedShare = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Quarterly report",
  description: "",
  scope: "read",
  paths: ["/report.pdf"],
  publicPath: "/s/00000000-0000-4000-8000-000000000001",
  hasPassword: false,
  expiresAt: null,
  maxDownloads: 0,
  usedDownloads: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  presentation: "auto",
};

const dropBox: ManagedShare = {
  ...share,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Drop box",
  scope: "write",
  paths: ["/Inbox"],
  publicPath: "/s/00000000-0000-4000-8000-000000000002",
  hasPassword: true,
  expiresAt: "2030-06-15T12:00:00Z",
  maxDownloads: 5,
  usedDownloads: 2,
  presentation: "list",
};

/**
 * The page folds its columns on a phone through `useIsMobile`, which reads `window.matchMedia`
 * (jsdom does not implement it) and decides from `window.innerWidth`.
 */
function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width < 768,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

function show(items: ManagedShare[]) {
  mocks.query = { isPending: false, isError: false, error: null, data: { items } };
  return render(<SharesPage />);
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("row", { name: new RegExp(name) });
}

beforeEach(() => {
  stubViewport(1024);
  mocks.query = { isPending: false, isError: false, error: null, data: { items: [share] } };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("lists the login's links and the folders it shares with people", () => {
  render(<SharesPage />);
  expect(screen.getByText("Quarterly report")).toBeTruthy();
  expect(screen.getByText("1 link")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Shared with people" })).toBeTruthy();
});

it("shows each link as one row: what it shares, who can do what, its use and its expiry", () => {
  show([share, dropBox]);

  for (const column of ["Name", "Item", "Access", "Shown as", "Usage", "Expires", "Actions"]) {
    expect(screen.getByRole("columnheader", { name: column })).toBeTruthy();
  }
  expect(screen.getByText("2 links")).toBeTruthy();

  const plain = within(rowOf("Quarterly report"));
  expect(plain.getByText("report.pdf")).toBeTruthy();
  expect(plain.getByText("Can view")).toBeTruthy();
  expect(plain.getByText("Automatic")).toBeTruthy();
  expect(plain.getByText("0 downloads · No limit")).toBeTruthy();
  expect(plain.getByText("Never")).toBeTruthy();
  expect(plain.queryByText("Password protected")).toBeNull();

  const protectedRow = within(rowOf("Drop box"));
  expect(protectedRow.getByText("Inbox")).toBeTruthy();
  expect(protectedRow.getByText("Can upload")).toBeTruthy();
  expect(protectedRow.getByText("List")).toBeTruthy();
  expect(protectedRow.getByText("2 of 5 uploads")).toBeTruthy();
  expect(protectedRow.getByText("Password protected")).toBeTruthy();
  // A short date and the time in the cell, the full one on hover.
  const expires = protectedRow.getByText(/2030 \d\d:\d\d$/);
  expect(expires.getAttribute("title")).toBe(new Date(dropBox.expiresAt ?? "").toLocaleString());
  expect(protectedRow.queryByText("Never")).toBeNull();
});

it("folds a link's details under its name on a phone, keeping its actions", () => {
  stubViewport(390);
  show([dropBox]);

  expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Actions" })).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: "Item" })).toBeNull();
  expect(screen.queryByRole("columnheader", { name: "Usage" })).toBeNull();
  expect(screen.getByText("Drop box")).toBeTruthy();
  expect(
    screen.getByText(
      /^Can upload · Password protected · Inbox · Expires .*2030 \d\d:\d\d · 2 of 5 uploads$/,
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy link for Drop box" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit Drop box" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revoke Drop box" })).toBeTruthy();
});

it("says when a link never expires on a phone", () => {
  stubViewport(390);
  show([share]);
  expect(
    screen.getByText("Can view · report.pdf · No expiry · 0 downloads · No limit"),
  ).toBeTruthy();
});

it("says there are no links yet, above the folders shared with people", () => {
  show([]);

  expect(screen.getByText("No share links yet")).toBeTruthy();
  expect(screen.getByText("0 links")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByRole("region", { name: "Shared with people" })).toBeTruthy();
});

it("says it is loading until the links arrive", () => {
  mocks.query = { isPending: true, isError: false, error: null, data: undefined };
  render(<SharesPage />);
  expect(screen.getByRole("status").textContent).toBe("Loading links…");
  expect(screen.queryByText("0 links")).toBeNull();
  expect(screen.queryByText("No share links yet")).toBeNull();
});

it("shows a failed listing as an alert without an empty table beneath it", () => {
  mocks.query = {
    isPending: false,
    isError: true,
    error: new ApiClientError("upstream_unavailable", "Share storage unavailable", 503),
    data: undefined,
  };
  render(<SharesPage />);
  expect(screen.getByText("Could not load share links")).toBeTruthy();
  expect(
    screen.getByText("fdrive can't reach the server. Check your connection and try again."),
  ).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: "Name" })).toBeNull();
  expect(screen.queryByText("No share links yet")).toBeNull();
});

it("copies a link's public address and confirms it on that row", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  show([share, dropBox]);

  fireEvent.click(screen.getByRole("button", { name: "Copy link for Drop box" }));

  const confirmation = await screen.findByRole("status");
  expect(confirmation.textContent).toBe("Link copied");
  expect(rowOf("Drop box").contains(confirmation)).toBe(true);
  expect(writeText).toHaveBeenCalledWith(new URL(`/s/${dropBox.id}`, window.location.origin).href);
  expect(mocks.gesture).toHaveBeenCalledWith("share.copy_link", "/Inbox", dropBox.id);
});

it("says when a link could not be copied", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  show([share]);

  fireEvent.click(screen.getByRole("button", { name: "Copy link for Quarterly report" }));

  expect((await screen.findByRole("alert")).textContent).toBe("Could not copy the link.");
  expect(screen.queryByRole("status")).toBeNull();
  // The list itself loaded, so the alert does not claim otherwise.
  expect(screen.queryByText("Could not load share links")).toBeNull();
  expect(screen.getByText("Quarterly report")).toBeTruthy();
});

it("opens a link for editing once its files are known", async () => {
  mocks.entries.mockResolvedValue([]);
  show([share]);

  fireEvent.click(screen.getByRole("button", { name: "Edit Quarterly report" }));

  expect(await screen.findByRole("dialog", { name: "Edit Quarterly report" })).toBeTruthy();
  expect(mocks.entries).toHaveBeenCalledWith(["/report.pdf"]);
});

it("says when a link's files could not be loaded for editing", async () => {
  mocks.entries.mockRejectedValue(new Error("gone"));
  show([share]);

  fireEvent.click(screen.getByRole("button", { name: "Edit Quarterly report" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not load the shared files. Refresh and try again.",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("revokes a link after asking", async () => {
  mocks.revoke.mockResolvedValue(undefined);
  show([share]);

  fireEvent.click(screen.getByRole("button", { name: "Revoke Quarterly report" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("Revoke Quarterly report?");
  expect(dialog.textContent).toContain("The original files remain in your storage.");

  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke link" }));

  await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(share.id));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});
