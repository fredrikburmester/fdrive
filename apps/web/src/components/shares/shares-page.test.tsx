// @vitest-environment jsdom
import type { FsEntry, ManagedShare } from "@fdrive/contracts";
import { ApiClientError } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharesPage } from "./shares-page";

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  revoke: vi.fn(),
  update: vi.fn(),
  entries: vi.fn(),
  gesture: vi.fn(),
}));
vi.mock("@/lib/shares/management", () => ({
  useShareManagement: () => ({
    query: mocks.query,
    create: vi.fn(),
    update: mocks.update,
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

/** What `share` shares, as storage has it. */
const reportFile: FsEntry = {
  name: "report.pdf",
  path: "/report.pdf",
  kind: "file",
  size: 1,
  modifiedAt: "2026-01-01T00:00:00Z",
  ext: ".pdf",
  mime: "application/pdf",
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

/** A chosen link's sheet asks what its shared paths are, through a query of its own. */
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function listing(items: ManagedShare[]) {
  return { isPending: false, isError: false, error: null, data: { items } };
}

function show(items: ManagedShare[]) {
  mocks.query = listing(items);
  return render(<SharesPage />, { wrapper });
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("row", { name: new RegExp(name) });
}

/** Chooses a link's row by its name and returns the sheet that opens. */
function choose(name: string): HTMLElement {
  fireEvent.click(within(rowOf(name)).getByText(name));
  return screen.getByRole("region", { name });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stubViewport(1024);
  mocks.query = listing([share]);
  mocks.entries.mockResolvedValue([reportFile]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("lists the login's links and the folders it shares with people", () => {
  render(<SharesPage />, { wrapper });
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
  expect(screen.getByRole("button", { name: "Revoke Drop box" })).toBeTruthy();

  // Its row opens the sheet with everything the phone row has no room for.
  const sheet = choose("Drop box");
  expect(within(sheet).getByText("Password protected")).toBeTruthy();
  expect(rowOf("Drop box").getAttribute("aria-selected")).toBe("true");
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

it("marks a link whose expiry has passed, in its row and on a phone", () => {
  const old = { ...share, name: "Old link", expiresAt: "2020-01-01T00:00:00Z" };
  const view = show([old]);
  expect(within(rowOf("Old link")).getByText("Expired").getAttribute("data-tone")).toBe("warning");
  expect(within(rowOf("Old link")).queryByText(/2020/)).toBeNull();
  view.unmount();

  stubViewport(390);
  show([old]);
  expect(screen.getByText("Can view · report.pdf · Expired · 0 downloads · No limit")).toBeTruthy();
});

it("says it is loading until the links arrive", () => {
  mocks.query = { isPending: true, isError: false, error: null, data: undefined };
  render(<SharesPage />, { wrapper });
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
  render(<SharesPage />, { wrapper });
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
  // The button keeps its own click: the row is not chosen.
  expect(screen.queryByRole("region", { name: "Drop box" })).toBeNull();
  expect(rowOf("Drop box").getAttribute("aria-selected")).toBe("false");
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

it("opens a chosen link's sheet beside the rows, with its settings once its files are known", async () => {
  show([share, dropBox]);
  expect(screen.queryByRole("region", { name: "Quarterly report" })).toBeNull();
  expect(rowOf("Quarterly report").getAttribute("data-state")).toBeNull();

  const sheet = choose("Quarterly report");

  expect(rowOf("Quarterly report").getAttribute("data-state")).toBe("selected");
  expect(rowOf("Quarterly report").getAttribute("aria-selected")).toBe("true");
  expect(rowOf("Drop box").getAttribute("data-state")).toBeNull();
  expect(document.activeElement).toBe(sheet);
  expect(within(sheet).getByRole("heading", { level: 2, name: "Quarterly report" })).toBeTruthy();
  expect(within(sheet).getByText("Active")).toBeTruthy();
  expect(
    (within(sheet).getByRole("textbox", { name: "Share link" }) as HTMLInputElement).value,
  ).toBe(new URL(`/s/${share.id}`, window.location.origin).href);
  expect(within(sheet).getByText("/report.pdf")).toBeTruthy();
  // The link is edited in the sheet: no dialog opens.
  expect(((await within(sheet).findByLabelText("Link name")) as HTMLInputElement).value).toBe(
    "Quarterly report",
  );
  expect(mocks.entries).toHaveBeenCalledWith(["/report.pdf"]);
  expect(screen.queryByRole("dialog")).toBeNull();

  // Another row's sheet takes its place.
  const other = choose("Drop box");
  expect(screen.queryByRole("region", { name: "Quarterly report" })).toBeNull();
  expect(within(other).getByText("Password protected")).toBeTruthy();
  expect(rowOf("Quarterly report").getAttribute("data-state")).toBeNull();
});

it("opens a link's sheet from the keyboard, and Escape or Close returns to its row", () => {
  show([share]);
  const row = rowOf("Quarterly report");
  expect(row.tabIndex).toBe(0);

  row.focus();
  fireEvent.keyDown(row, { key: "Enter" });
  const sheet = screen.getByRole("region", { name: "Quarterly report" });
  expect(document.activeElement).toBe(sheet);

  fireEvent.keyDown(sheet, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Quarterly report" })).toBeNull();
  expect(document.activeElement).toBe(row);
  expect(row.getAttribute("aria-selected")).toBe("false");

  fireEvent.keyDown(row, { key: " " });
  fireEvent.click(
    within(screen.getByRole("region", { name: "Quarterly report" })).getByRole("button", {
      name: "Close",
    }),
  );
  expect(screen.queryByRole("region", { name: "Quarterly report" })).toBeNull();
  expect(document.activeElement).toBe(row);
});

it("saves a link's settings from its sheet", async () => {
  mocks.update.mockResolvedValue({ ...share, name: "Renamed" });
  show([share]);
  const sheet = choose("Quarterly report");

  fireEvent.change(await within(sheet).findByLabelText("Link name"), {
    target: { value: "Renamed" },
  });
  fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));

  expect(await within(sheet).findByText("Changes saved")).toBeTruthy();
  expect(mocks.update).toHaveBeenCalledWith(share.id, expect.objectContaining({ name: "Renamed" }));
});

it("says in the sheet when a link's files could not be loaded, and keeps the sheet open", async () => {
  mocks.entries.mockRejectedValue(new Error("gone"));
  show([share]);

  const sheet = choose("Quarterly report");

  expect(
    await within(sheet).findByText("Could not load the shared files. Refresh and try again."),
  ).toBeTruthy();
  expect(within(sheet).queryByLabelText("Link name")).toBeNull();
  expect(within(sheet).getByRole("button", { name: "Revoke link" })).toBeTruthy();
  // The list itself is fine, so the page says nothing above it.
  expect(screen.queryByText("Could not load share links")).toBeNull();
});

it("closes a link's sheet when the listing fails", () => {
  const view = show([share]);
  choose("Quarterly report");

  mocks.query = {
    isPending: false,
    isError: true,
    error: new ApiClientError("upstream_unavailable", "Share storage unavailable", 503),
    data: { items: [share] },
  };
  view.rerender(<SharesPage />);

  expect(screen.queryByRole("region", { name: "Quarterly report" })).toBeNull();
  expect(screen.getByText("Could not load share links")).toBeTruthy();
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
  // Asking from the row does not choose it.
  expect(screen.queryByRole("region", { name: "Quarterly report" })).toBeNull();
});

it("revokes from the sheet's footer after asking, and the sheet closes with its row", async () => {
  mocks.revoke.mockResolvedValue(undefined);
  const view = show([share, dropBox]);
  const sheet = choose("Drop box");

  fireEvent.click(within(sheet).getByRole("button", { name: "Revoke link" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("Revoke Drop box?");
  expect(mocks.revoke).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke link" }));
  await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(dropBox.id));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

  // The list comes back without the link, and its sheet goes with it.
  mocks.query = listing([share]);
  view.rerender(<SharesPage />);
  expect(screen.queryByRole("region", { name: "Drop box" })).toBeNull();
  expect(screen.getByText("Quarterly report")).toBeTruthy();
});

it("keeps asking when a link could not be revoked", async () => {
  mocks.revoke.mockRejectedValue(new Error("offline"));
  show([share]);

  fireEvent.click(screen.getByRole("button", { name: "Revoke Quarterly report" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke link" }));

  expect(await within(dialog).findByText("Could not revoke the link. Try again.")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Revoke link" })).toHaveProperty(
    "disabled",
    false,
  );
});
