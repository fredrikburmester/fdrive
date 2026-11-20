// @vitest-environment jsdom
import type { PersonalActivityEvent } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryPage } from "./history-page";

const mocks = vi.hoisted(() => ({
  identityId: "00000000-0000-4000-8000-0000000000aa",
  history: {} as Record<string, unknown>,
  historyCalls: [] as unknown[][],
  file: {} as Record<string, unknown>,
  push: vi.fn(),
  activityFile: vi.fn(),
  activityRequest: vi.fn(),
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
// The shell header needs the sidebar context; the page's title is all this test reads from it.
vi.mock("@/components/shell/page-header", () => ({
  PageHeader: ({ breadcrumbs }: { breadcrumbs: ReactNode }) => <header>{breadcrumbs}</header>,
}));
vi.mock("./journey-details", () => ({
  JourneyDetails: ({ fileId }: { fileId: string }) => (
    <div data-testid="journey-details">{fileId}</div>
  ),
}));
vi.mock("@/lib/activity/queries", () => ({
  useActivityHistory: (...args: unknown[]) => {
    mocks.historyCalls.push(args);
    return mocks.history;
  },
  useActivityFile: () => mocks.file,
}));
vi.mock("@/lib/activity/api", () => ({
  activityFile: mocks.activityFile,
  activityRequest: mocks.activityRequest,
}));
vi.mock("@/lib/api/auth-queries", () => ({
  useMe: () => ({ data: { account: { id: "account" }, identity: { id: mocks.identityId } } }),
}));

const FILE_ID = "00000000-0000-4000-8000-0000000000f1";
const BATCH_ID = "00000000-0000-4000-8000-0000000000b1";

/** Noon on a day `daysAgo` before today, local time: well inside that calendar day. */
function noon(daysAgo: number, hour = 12): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function event(overrides: Partial<PersonalActivityEvent>): PersonalActivityEvent {
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    sequence: "1",
    identityId: mocks.identityId,
    actorAccountId: null,
    fileId: FILE_ID,
    action: "file.upload",
    class: "action",
    stage: "outcome",
    outcome: "success",
    source: "web",
    evidence: "server_confirmed",
    operationId: null,
    batchId: null,
    parentEventId: null,
    occurredAt: null,
    recordedAt: noon(0),
    sortAt: noon(0),
    lastConfirmedAt: null,
    detectedAt: null,
    before: null,
    after: null,
    detail: null,
    errorCode: null,
    count: 1,
    firstAt: null,
    lastAt: null,
    outcomeCounts: null,
    subjects: [],
    subjectsTruncated: false,
    provisional: false,
    ...overrides,
  };
}

const renamed = event({
  id: "00000000-0000-4000-8000-000000000002",
  action: "file.rename",
  sortAt: noon(0, 12),
  before: { path: "/docs/old.txt", kind: "file" },
  after: { path: "/docs/renamed.txt", kind: "file", size: 2048 },
  batchId: BATCH_ID,
});
const uploaded = event({
  id: "00000000-0000-4000-8000-000000000003",
  action: "file.upload",
  sortAt: noon(0, 11),
  after: { path: "/top.txt", kind: "file" },
});
const trashed = event({
  id: "00000000-0000-4000-8000-000000000004",
  action: "file.trash",
  sortAt: noon(1),
  outcome: "failed",
  errorCode: "not_found",
  source: "native",
  after: { path: "/docs/gone", kind: "dir" },
});

function feed(
  items: PersonalActivityEvent[],
  page: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
) {
  return {
    data: {
      pages: [
        {
          items,
          provisionalReads: [],
          nextCursor: null,
          historyStartsAt: null,
          retainedFrom: null,
          ...page,
        },
      ],
    },
    isPending: false,
    isError: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: mocks.fetchNextPage,
    refetch: mocks.refetch,
    ...query,
  };
}

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

function renderPage(props: { fileId?: string; batchId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HistoryPage {...props} />
    </QueryClientProvider>,
  );
}

/** The filters the page last asked the feed for. */
function lastFilters(): Record<string, unknown> {
  return mocks.historyCalls.at(-1)?.[0] as Record<string, unknown>;
}

/** The label and value pairs a sheet lists. */
function factsOf(sheet: HTMLElement): Record<string, string | null | undefined> {
  return Object.fromEntries(
    [...sheet.querySelectorAll("dt")].map((term) => [
      term.textContent ?? "",
      term.nextElementSibling?.textContent,
    ]),
  );
}

function rowOf(text: string): HTMLElement {
  const row = within(screen.getByRole("table")).getByText(text).closest("tr");
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
}

/** The sheet docked beside the table, or `null` while nothing is chosen. */
function dockedSheet(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="detail-sheet"]');
}

/** Chooses the row that holds `text` and returns the sheet it opens. */
function choose(text: string): HTMLElement {
  fireEvent.click(rowOf(text));
  const sheet = dockedSheet();
  if (sheet === null) throw new Error(`choosing ${text} opened no sheet`);
  return sheet;
}

beforeEach(() => {
  stubViewport(1024);
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
  mocks.history = feed([renamed, uploaded, trashed]);
  mocks.file = { isPending: true, isError: false };
  mocks.historyCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

it("lists events as table rows grouped by the day they happened", () => {
  renderPage();

  expect(screen.getByRole("heading", { name: "My activity" })).toBeTruthy();
  expect(screen.getByText("3 events")).toBeTruthy();
  const head = document.querySelector("thead");
  if (head === null) throw new Error("the table has no header");
  expect(
    within(head)
      .getAllByRole("columnheader")
      .map((column) => column.textContent),
  ).toEqual(["Time", "Action", "Item", "Location", "Client", "Result"]);

  const groups = [...document.querySelectorAll('[data-slot="table-group-row"]')];
  expect(groups.map((group) => group.textContent)).toEqual(["Today2", "Yesterday1"]);
  // Newest first: both of today's rows sit between the two day rows.
  const rows = [...document.querySelectorAll("tbody tr")].map((row) =>
    row.getAttribute("data-slot"),
  );
  expect(rows).toEqual([
    "table-group-row",
    "activity-row",
    "activity-row",
    "table-group-row",
    "activity-row",
  ]);

  const rename = within(rowOf("Renamed"));
  expect(rename.getByText("12:00")).toBeTruthy();
  expect(rename.getByText("renamed.txt")).toBeTruthy();
  expect(rename.getByText("from old.txt")).toBeTruthy();
  expect(rename.getByText("/docs")).toBeTruthy();
  expect(rename.getByText("Web")).toBeTruthy();
  expect(rename.getByText("Success")).toBeTruthy();

  // A top-level item is in Home, and a failed action stands out.
  expect(within(rowOf("Uploaded")).getByText("Home")).toBeTruthy();
  const failed = within(rowOf("Moved to Trash")).getByText("Failed");
  expect(failed.className).toContain("text-destructive");
  expect(within(rowOf("Moved to Trash")).getByText("Native app")).toBeTruthy();

  // Nothing is chosen until a row is, so no sheet is docked beside the table.
  expect(dockedSheet()).toBeNull();
  for (const row of document.querySelectorAll('[data-slot="activity-row"]')) {
    expect(row.getAttribute("aria-selected")).toBe("false");
    expect(row.hasAttribute("data-state")).toBe(false);
  }
});

it("says how often a repeated action happened and marks a read that is not settled yet", () => {
  mocks.history = feed([
    event({ action: "file.open", count: 3, provisional: true, after: { path: "/top.txt" } }),
  ]);
  renderPage();

  const row = within(rowOf("Opened 3 times"));
  expect(row.getByText("Recent")).toBeTruthy();
  expect(screen.getByText("1 event")).toBeTruthy();
});

it("docks a chosen row's event in a sheet beside the table, and closes it again", () => {
  renderPage();
  const row = rowOf("Renamed");

  const sheet = choose("Renamed");

  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(row.getAttribute("data-state")).toBe("selected");
  expect(rowOf("Uploaded").getAttribute("aria-selected")).toBe("false");
  // The sheet is a column of the dock, after the rows, and says what happened as its title.
  expect(sheet.getAttribute("data-width")).toBe("docked");
  expect(sheet.parentElement?.getAttribute("data-slot")).toBe("sheet-dock");
  expect(screen.getByRole("region", { name: "Renamed" })).toBe(sheet);
  const panel = within(sheet);
  expect(panel.getByRole("heading", { level: 2, name: "Renamed" })).toBeTruthy();
  expect(panel.getByText("renamed.txt")).toBeTruthy();
  expect(panel.getByText("Success").getAttribute("data-tone")).toBe("success");
  expect(panel.getByRole("button", { name: "Open" })).toBeTruthy();
  expect(panel.getByRole("button", { name: "Show in folder" })).toBeTruthy();
  expect(panel.getByRole("link", { name: "File journey" }).getAttribute("href")).toBe(
    `/activity/files/${FILE_ID}`,
  );
  expect(panel.getByRole("link", { name: "View batch" }).getAttribute("href")).toBe(
    `/activity/batches/${BATCH_ID}`,
  );
  const facts = factsOf(sheet);
  expect(facts).toMatchObject({
    Path: "/docs/renamed.txt",
    From: "/docs/old.txt",
    Client: "Web",
    Evidence: "Server confirmed",
    Size: `${(2048).toLocaleString()} bytes`,
  });
  expect(facts.When).toBe(new Date(renamed.sortAt).toLocaleString());
  // The file's journey is part of the event's sheet.
  expect(panel.getByTestId("journey-details").textContent).toBe(FILE_ID);

  // Nothing opened in place: the table has the rows it had, and no disclosure anywhere.
  expect(document.querySelectorAll("tbody tr")).toHaveLength(5);
  expect(document.querySelector("details")).toBeNull();
  expect(screen.getByRole("table").querySelector("[aria-expanded]")).toBeNull();

  // Choosing another row shows that event in the sheet's place.
  const other = choose("Uploaded");
  expect(screen.getByRole("region", { name: "Uploaded" })).toBe(other);
  expect(document.querySelectorAll('[data-slot="detail-sheet"]')).toHaveLength(1);
  expect(row.getAttribute("aria-selected")).toBe("false");

  fireEvent.click(within(other).getByRole("button", { name: "Close" }));
  expect(dockedSheet()).toBeNull();
  expect(rowOf("Uploaded").getAttribute("aria-selected")).toBe("false");
  // Focus goes back to the row the sheet was opened from.
  expect(document.activeElement).toBe(rowOf("Uploaded"));
});

it("chooses a row from the keyboard and closes its sheet with Escape", () => {
  renderPage();
  const row = rowOf("Renamed");
  expect(row.tabIndex).toBe(0);

  row.focus();
  fireEvent.keyDown(row, { key: "Enter" });
  const sheet = dockedSheet();
  if (sheet === null) throw new Error("Enter opened no sheet");
  // Focus moves into the sheet, which is past every row in the tab order.
  expect(document.activeElement).toBe(sheet);

  fireEvent.keyDown(sheet, { key: "Escape" });
  expect(dockedSheet()).toBeNull();
  expect(document.activeElement).toBe(row);

  fireEvent.keyDown(row, { key: " " });
  expect(dockedSheet()).not.toBeNull();
  // Escape inside the sheet closes it from wherever focus is.
  const close = screen.getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "Escape" });
  expect(dockedSheet()).toBeNull();
  expect(document.activeElement).toBe(row);

  // Escape on a row closes the sheet too, and other keys do nothing.
  fireEvent.keyDown(row, { key: "Enter" });
  const uploaded = rowOf("Uploaded");
  uploaded.focus();
  fireEvent.keyDown(uploaded, { key: "ArrowDown" });
  expect(dockedSheet()).not.toBeNull();
  fireEvent.keyDown(uploaded, { key: "Escape" });
  expect(dockedSheet()).toBeNull();
  expect(document.activeElement).toBe(uploaded);
  // With nothing open, Escape has nothing to close.
  fireEvent.keyDown(uploaded, { key: "Escape" });
  expect(dockedSheet()).toBeNull();
});

it("leaves the keys of a link inside a row to that link", () => {
  renderPage();

  fireEvent.keyDown(within(rowOf("Renamed")).getByRole("button", { name: "renamed.txt" }), {
    key: "Enter",
  });

  expect(dockedSheet()).toBeNull();
});

it("keeps the sheet on an operation while its outcome replaces its intent", () => {
  const operationId = "00000000-0000-4000-8000-0000000000c1";
  mocks.history = feed([
    event({
      id: "00000000-0000-4000-8000-000000000011",
      operationId,
      stage: "intent",
      outcome: null,
      after: { path: "/top.txt" },
    }),
  ]);
  renderPage();
  expect(within(choose("Uploaded")).getByText("Started")).toBeTruthy();

  mocks.history = feed([
    event({
      id: "00000000-0000-4000-8000-000000000012",
      operationId,
      after: { path: "/top.txt" },
    }),
  ]);
  // Anything that renders the page again reads the feed again.
  fireEvent.change(screen.getByLabelText("Search activity by name or path"), {
    target: { value: "t" },
  });

  const sheet = dockedSheet();
  if (sheet === null) throw new Error("the sheet closed when the outcome arrived");
  expect(within(sheet).getByText("Success")).toBeTruthy();
  expect(rowOf("Uploaded").getAttribute("aria-selected")).toBe("true");
});

it("closes the sheet of an event the feed no longer shows, for good", () => {
  renderPage();
  choose("Renamed");

  mocks.history = feed([uploaded]);
  fireEvent.change(screen.getByLabelText("Search activity by name or path"), {
    target: { value: "t" },
  });
  expect(dockedSheet()).toBeNull();

  // The event coming back does not open its sheet again.
  mocks.history = feed([renamed, uploaded]);
  fireEvent.change(screen.getByLabelText("Search activity by name or path"), {
    target: { value: "" },
  });
  expect(rowOf("Renamed").getAttribute("aria-selected")).toBe("false");
  expect(dockedSheet()).toBeNull();
});

it("lists what a failed event recorded, and the files a larger one touched", () => {
  mocks.history = feed([
    event({
      action: "share.update",
      evidence: "client_reported",
      outcome: "failed",
      errorCode: "not_found",
      lastConfirmedAt: noon(0),
      firstAt: noon(0, 9),
      lastAt: noon(0, 10),
      before: { path: "/docs/a.txt", favorite: false, permissions: ["read"], expiresAt: null },
      after: {
        path: "/docs/a.txt",
        trashLeaf: "/.trash/a",
        tags: [],
        favorite: true,
        view: "grid",
        completedCount: 2,
        failedCount: 1,
      },
      subjects: [
        {
          fileId: FILE_ID,
          identityId: mocks.identityId,
          role: "primary",
          ordinal: 0,
          path: "/docs/a.txt",
          revisionId: null,
        },
        {
          fileId: null,
          identityId: mocks.identityId,
          role: "affected",
          ordinal: 1,
          path: null,
          revisionId: null,
        },
      ],
    }),
  ]);
  renderPage();

  const sheet = choose("Updated share");

  const panel = within(sheet);
  expect(panel.getByText("Failed").getAttribute("data-tone")).toBe("danger");
  expect(panel.getByText("Reported by your client")).toBeTruthy();
  // The files are listed in the open, each a link to its own journey where it has one.
  const files = panel.getByRole("heading", { name: "Files involved (2)" }).closest("section");
  if (files === null) throw new Error("the files have no block of their own");
  const members = within(files).getAllByRole("listitem");
  expect(members.map((member) => member.textContent)).toEqual([
    "primary/docs/a.txt",
    "affectedLocation unavailable",
  ]);
  expect(within(files).getByRole("link", { name: "/docs/a.txt" }).getAttribute("href")).toBe(
    `/activity/files/${FILE_ID}`,
  );
  expect(sheet.querySelector("details")).toBeNull();
  const facts = factsOf(sheet);
  expect(facts).toMatchObject({
    Evidence: "Client reported",
    Result: "Not found",
    "Trash location": "/.trash/a",
    Before: "Favorite: no · Share permissions: read · Share expiry: none",
    After: "Tags: none · Favorite: yes · Folder view: grid · Completed: 2 · Failed: 1",
  });
  expect(facts["Last confirmed"]).toBe(new Date(noon(0)).toLocaleString());
  expect(facts["Time range"]).toBe(
    `${new Date(noon(0, 9)).toLocaleTimeString()} – ${new Date(noon(0, 10)).toLocaleTimeString()}`,
  );
  // The item did not move, so there is nowhere it came from.
  expect(facts.From).toBeUndefined();
});

it("opens the file from its name and shows it in its folder from its location", async () => {
  mocks.activityFile.mockResolvedValue({ currentPath: "/docs/renamed.txt", kind: "file" });
  renderPage();
  const row = within(rowOf("Renamed"));

  fireEvent.click(row.getByRole("button", { name: "renamed.txt" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/view/docs/renamed.txt"));
  expect(mocks.activityFile).toHaveBeenCalledWith(FILE_ID);

  await waitFor(() => expect(row.getByRole("button", { name: "/docs" })).toBeTruthy());
  fireEvent.click(row.getByRole("button", { name: "/docs" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/files/docs?select=renamed.txt"));
  // Going to the file is not choosing its row.
  expect(dockedSheet()).toBeNull();
});

it("opens a folder in the file browser, and shows a file in its folder, from the sheet", async () => {
  mocks.activityFile.mockResolvedValue({ currentPath: "/docs/kept", kind: "dir" });
  renderPage();

  const panel = within(choose("Moved to Trash"));
  fireEvent.click(panel.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/files/docs/kept"));

  await waitFor(() =>
    expect(panel.getByRole("button", { name: "Show in folder" })).toHaveProperty("disabled", false),
  );
  fireEvent.click(panel.getByRole("button", { name: "Show in folder" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/files/docs?select=kept"));
});

it("says when a file can no longer be opened, keeping its journey", async () => {
  mocks.activityFile.mockResolvedValue({ currentPath: null, kind: "file" });
  renderPage();

  fireEvent.click(within(rowOf("Uploaded")).getByRole("button", { name: "top.txt" }));

  await waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This file is unavailable. Its recorded journey is still here.",
    ),
  );
  expect(mocks.push).not.toHaveBeenCalled();

  mocks.activityFile.mockRejectedValue("offline");
  await waitFor(() =>
    expect(within(rowOf("Uploaded")).getByRole("button", { name: "top.txt" })).toBeTruthy(),
  );
  fireEvent.click(within(rowOf("Uploaded")).getByRole("button", { name: "top.txt" }));
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Could not open this file"));
});

it("does not offer to open a file another login recorded, or an event without one", () => {
  mocks.history = feed([
    event({
      id: "00000000-0000-4000-8000-000000000005",
      identityId: "00000000-0000-4000-8000-0000000000bb",
      after: { path: "/docs/theirs.txt" },
    }),
    event({
      id: "00000000-0000-4000-8000-000000000006",
      action: "trash.empty",
      fileId: null,
      sortAt: noon(0, 9),
    }),
  ]);
  renderPage();

  const theirs = within(rowOf("Uploaded"));
  expect(theirs.getByText("theirs.txt")).toBeTruthy();
  expect(theirs.queryByRole("button", { name: "theirs.txt" })).toBeNull();
  expect(theirs.queryByRole("button", { name: "/docs" })).toBeNull();
  const sheet = within(choose("Uploaded"));
  expect(sheet.getByRole("button", { name: "Open" })).toHaveProperty("disabled", true);
  expect(sheet.getByRole("button", { name: "Show in folder" })).toHaveProperty("disabled", true);

  // An event about no file has no item, no location, and nothing to open or follow in its sheet.
  const emptied = rowOf("Emptied Trash");
  expect(within(emptied).getAllByText("--")).toHaveLength(2);
  const empty = within(choose("Emptied Trash"));
  expect(empty.getByRole("heading", { level: 2, name: "Emptied Trash" })).toBeTruthy();
  expect(empty.queryByRole("button", { name: "Open" })).toBeNull();
  expect(empty.queryByRole("link", { name: "File journey" })).toBeNull();
  expect(empty.queryByTestId("journey-details")).toBeNull();
  expect(empty.queryByText(/^Files involved/)).toBeNull();
});

it("keeps what an observation leaves uncertain in the row itself, and in its sheet", () => {
  mocks.history = feed([
    event({
      id: "00000000-0000-4000-8000-000000000007",
      action: "observation.resolved",
      class: "observation",
      outcome: null,
      source: "indexer",
      after: { path: "/docs/back.txt" },
    }),
  ]);
  renderPage();

  const row = within(rowOf("Unknown event resolved"));
  expect(
    row.getByText("Detected outside a confirmed fdrive action. Who made this change is unknown."),
  ).toBeTruthy();
  expect(row.getByText(/Whether this is the earlier file remains unknown/)).toBeTruthy();
  expect(row.getByText("Started")).toBeTruthy();

  const sheet = within(choose("Unknown event resolved"));
  expect(
    sheet.getByText("Detected outside a confirmed fdrive action. Who made this change is unknown."),
  ).toBeTruthy();
  expect(sheet.getByText(/Whether this is the earlier file remains unknown/)).toBeTruthy();
  expect(sheet.getByText("Started").getAttribute("data-tone")).toBe("neutral");
});

it("folds each row to two lines on a phone and puts the filters behind a button", () => {
  stubViewport(390);
  renderPage();

  expect(screen.getByRole("columnheader", { name: "Activity" })).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: "Location" })).toBeNull();
  const rename = within(rowOf("Renamed"));
  expect(rename.getByText("renamed.txt")).toBeTruthy();
  expect(rename.getByText("12:00")).toBeTruthy();
  expect(rename.getByText("· /docs")).toBeTruthy();
  // Only a result worth a look takes room on a phone.
  expect(rename.queryByText(/Success/)).toBeNull();
  expect(within(rowOf("Moved to Trash")).getByText("· Failed")).toBeTruthy();
  // A row is chosen on a phone as anywhere else, and its sheet has the way back.
  const sheet = choose("Renamed");
  expect(within(sheet).getByRole("heading", { level: 2, name: "Renamed" })).toBeTruthy();
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  expect(dockedSheet()).toBeNull();

  expect(screen.queryByRole("combobox", { name: "Action" })).toBeNull();
  const filters = screen.getByRole("button", { name: "Filters" });
  expect(filters.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(filters);
  expect(filters.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("combobox", { name: "Action" })).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Activity from date"), {
    target: { value: "2026-03-10" },
  });
  expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
  // Closing the filters keeps them, and the date is still there when they open again.
  fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
  expect(screen.queryByLabelText("Activity from date")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
  expect(screen.getByLabelText<HTMLInputElement>("Activity from date").value).toBe("2026-03-10");
});

it("searches and filters the feed, and clears the filters without losing the search", async () => {
  renderPage();
  expect(lastFilters()).toEqual({});
  expect(mocks.historyCalls.at(-1)?.[1]).toBe("");
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();

  fireEvent.change(screen.getByLabelText("Search activity by name or path"), {
    target: { value: "report" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(lastFilters()).toEqual({ q: "report" });

  fireEvent.click(screen.getByRole("combobox", { name: "Source" }));
  fireEvent.keyDown(await screen.findByRole("option", { name: "Office" }), { key: "Enter" });
  await waitFor(() => expect(lastFilters()).toMatchObject({ q: "report", source: "office" }));

  fireEvent.change(screen.getByLabelText("Activity from date"), {
    target: { value: "2026-03-10" },
  });
  fireEvent.change(screen.getByLabelText("Activity through date"), {
    target: { value: "2026-03-12" },
  });
  expect(lastFilters()).toMatchObject({
    from: new Date("2026-03-10T00:00:00").toISOString(),
    to: new Date("2026-03-12T23:59:59.999").toISOString(),
  });

  // Emptying a date drops that bound alone.
  fireEvent.change(screen.getByLabelText("Activity through date"), { target: { value: "" } });
  expect(lastFilters().to).toBeUndefined();
  expect(lastFilters().from).toBe(new Date("2026-03-10T00:00:00").toISOString());

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(lastFilters()).toEqual({ q: "report" });
  expect(screen.getByLabelText<HTMLInputElement>("Activity from date").value).toBe("");
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});

it("shows placeholder rows while the feed loads", () => {
  mocks.history = feed([], {}, { data: undefined, isPending: true });
  renderPage();

  expect(screen.getByRole("status").textContent).toBe("Loading your activity…");
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByText("No activity here yet")).toBeNull();
  expect(screen.queryByText("0 events")).toBeNull();
});

it("offers a retry when the feed fails", () => {
  mocks.history = feed(
    [],
    {},
    { data: undefined, isError: true, error: new Error("History is unavailable") },
  );
  renderPage();

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("History is unavailable");
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(mocks.refetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("No activity here yet")).toBeNull();
});

it("says when there is no activity, and when history starts", () => {
  mocks.history = feed([], { historyStartsAt: "2026-01-05T00:00:00.000Z" });
  const view = renderPage();

  expect(screen.getByText("No activity here yet")).toBeTruthy();
  expect(screen.getByText("0 events")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText(/Journey metadata is kept without an automatic cutoff\./)).toBeTruthy();
  expect(
    screen.getByText("Changes made outside fdrive appear once the indexer notices them."),
  ).toBeTruthy();
  view.unmount();

  mocks.history = feed([], {
    historyStartsAt: "2026-01-05T00:00:00.000Z",
    retainedFrom: "2026-02-01T00:00:00.000Z",
  });
  renderPage();
  expect(screen.getByText(/Retained from /)).toBeTruthy();
});

it("loads more events on request", () => {
  mocks.history = feed([renamed], {}, { hasNextPage: true });
  const view = renderPage();

  expect(screen.getByText("1+ events")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  view.unmount();

  mocks.history = feed([renamed], {}, { hasNextPage: true, isFetchingNextPage: true });
  renderPage();
  expect(screen.getByRole("button", { name: "Loading…" })).toHaveProperty("disabled", true);
});

it("exports what the filters show and links to the download", async () => {
  mocks.activityRequest.mockResolvedValue({ id: "export 1" });
  renderPage();
  fireEvent.change(screen.getByLabelText("Search activity by name or path"), {
    target: { value: "report" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));

  fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

  const download = await screen.findByRole("link", { name: "Download export" });
  expect(download.getAttribute("href")).toBe("/api/v1/activity/exports/export%201/download");
  expect(mocks.activityRequest).toHaveBeenCalledWith("/exports", {
    method: "POST",
    body: JSON.stringify({ format: "csv", filters: { q: "report" } }),
  });
});

it("says when an export could not be made", async () => {
  mocks.activityRequest.mockRejectedValue(new Error("Too many exports"));
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));

  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Too many exports"));
  expect(screen.queryByRole("link", { name: "Download export" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Export JSON" })).toHaveProperty("disabled", false),
  );

  mocks.activityRequest.mockRejectedValue("offline");
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Could not create export"));
});

it("shows one file's journey: where it is now, then what happened to it", async () => {
  mocks.file = {
    isPending: false,
    isError: false,
    data: {
      id: FILE_ID,
      identityId: mocks.identityId,
      label: "ada",
      kind: "file",
      lastKnownPath: "/docs/renamed.txt",
      currentPath: "/docs/renamed.txt",
      availability: "live",
      lastConfirmedAt: noon(1),
      revisionId: null,
    },
  };
  mocks.activityRequest.mockResolvedValue({ id: "e1" });
  renderPage({ fileId: FILE_ID });

  expect(screen.getByRole("heading", { name: "File journey" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "My activity" }).getAttribute("href")).toBe("/activity");
  expect(mocks.historyCalls.at(-1)?.[1]).toBe(`/files/${FILE_ID}/events`);
  expect(screen.getByRole("heading", { name: "renamed.txt" })).toBeTruthy();
  expect(screen.getByText("Live").getAttribute("data-tone")).toBe("success");
  expect(
    screen.getByText(
      "ada · Revision records describe changes; earlier file contents are not stored.",
    ),
  ).toBeTruthy();
  // The file's related files and revisions wait in its sheet; nothing opens above the table.
  expect(screen.queryByTestId("journey-details")).toBeNull();
  expect(document.querySelector("details")).toBeNull();

  const details = screen.getByRole("button", { name: "File details" });
  expect(details.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(details);
  expect(details.getAttribute("aria-expanded")).toBe("true");
  const fileSheet = dockedSheet();
  if (fileSheet === null) throw new Error("the file's sheet did not open");
  expect(screen.getByRole("region", { name: "renamed.txt" })).toBe(fileSheet);
  expect(document.activeElement).toBe(fileSheet);
  expect(within(fileSheet).getByTestId("journey-details").textContent).toBe(FILE_ID);
  expect(factsOf(fileSheet)).toEqual({
    Location: "/docs/renamed.txt",
    Kind: "File",
    Login: "ada",
    "Last confirmed": new Date(noon(1)).toLocaleString(),
  });
  fireEvent.keyDown(fileSheet, { key: "Escape" });
  expect(dockedSheet()).toBeNull();
  expect(document.activeElement).toBe(details);

  // A row about this file needs no link to the journey it is already on, and its sheet does not
  // repeat what the file's own sheet shows.
  const eventSheet = within(choose("Renamed"));
  expect(eventSheet.queryByRole("link", { name: "File journey" })).toBeNull();
  expect(eventSheet.queryByTestId("journey-details")).toBeNull();
  expect(eventSheet.getByRole("link", { name: "View batch" })).toBeTruthy();
  // One sheet at a time: the file's takes the event's place.
  fireEvent.click(details);
  expect(document.querySelectorAll('[data-slot="detail-sheet"]')).toHaveLength(1);
  expect(rowOf("Renamed").getAttribute("aria-selected")).toBe("false");

  // An export from here covers this file alone.
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  await screen.findByRole("link", { name: "Download export" });
  expect(mocks.activityRequest).toHaveBeenCalledWith("/exports", {
    method: "POST",
    body: JSON.stringify({ format: "json", filters: { fileId: FILE_ID } }),
  });
});

it("says while a journey's file is being found, and when it cannot be", () => {
  const view = renderPage({ fileId: FILE_ID });
  expect(screen.getByText("Finding the current location…")).toBeTruthy();
  view.unmount();

  mocks.file = { isPending: false, isError: true, error: new Error("No such file") };
  renderPage({ fileId: FILE_ID });
  expect(screen.getByText("No such file")).toBeTruthy();
});

it("falls back to where a file was last seen, without a label", () => {
  mocks.file = {
    isPending: false,
    isError: false,
    data: {
      id: FILE_ID,
      identityId: mocks.identityId,
      label: "",
      kind: "file",
      lastKnownPath: "/docs/lost.txt",
      currentPath: null,
      availability: "unknown",
      lastConfirmedAt: null,
      revisionId: null,
    },
  };
  renderPage({ fileId: FILE_ID });

  expect(screen.getByRole("heading", { name: "lost.txt" })).toBeTruthy();
  expect(screen.getByText("/docs/lost.txt")).toBeTruthy();
  expect(screen.getByText("Unknown").getAttribute("data-tone")).toBe("warning");
  expect(
    screen.getByText("Revision records describe changes; earlier file contents are not stored."),
  ).toBeTruthy();

  // Its sheet says where it was last seen, since nowhere holds it now.
  fireEvent.click(screen.getByRole("button", { name: "File details" }));
  const sheet = dockedSheet();
  if (sheet === null) throw new Error("the file's sheet did not open");
  expect(factsOf(sheet)).toEqual({ "Last seen at": "/docs/lost.txt", Kind: "File" });
});

it("offers no sheet for a journey's file until the file is known", () => {
  renderPage({ fileId: FILE_ID });

  expect(screen.queryByRole("button", { name: "File details" })).toBeNull();
  expect(dockedSheet()).toBeNull();
});

it("shows one batch's events with how its operations ended", () => {
  mocks.history = feed([renamed], {
    batchSummary: { total: 3, outcomes: { success: 2, failed: 1 } },
  });
  renderPage({ batchId: BATCH_ID });

  expect(screen.getByRole("heading", { name: "Batch" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "My activity" })).toBeTruthy();
  expect(mocks.historyCalls.at(-1)?.[1]).toBe(`/batches/${BATCH_ID}/events`);
  expect(screen.getByText("Actions from this batch")).toBeTruthy();
  expect(screen.getByText("3 operations · 2 success · 1 failed")).toBeTruthy();
});
