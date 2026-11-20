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

/** The label and value pairs an open details row lists. */
function factsOf(details: HTMLElement): Record<string, string | null | undefined> {
  return Object.fromEntries(
    [...details.querySelectorAll("dt")].map((term) => [
      term.textContent ?? "",
      term.nextElementSibling?.textContent,
    ]),
  );
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest("tr");
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
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
  for (const column of ["Time", "Action", "Item", "Location", "Client", "Result"]) {
    expect(screen.getByRole("columnheader", { name: column })).toBeTruthy();
  }

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
  expect(rename.getByText("web")).toBeTruthy();
  expect(rename.getByText("success")).toBeTruthy();

  // A top-level item is in Home, and a failed action stands out.
  expect(within(rowOf("Uploaded")).getByText("Home")).toBeTruthy();
  const failed = within(rowOf("Moved to Trash")).getByText("failed");
  expect(failed.className).toContain("text-destructive");
  expect(within(rowOf("Moved to Trash")).getByText("native")).toBeTruthy();
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

it("opens a row into everything recorded about the event, and closes it again", () => {
  renderPage();
  const toggle = screen.getByRole("button", { name: "Details for Renamed renamed.txt" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[data-slot="activity-details"]')).toBeNull();

  fireEvent.click(toggle);

  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const details = document.querySelector<HTMLElement>('[data-slot="activity-details"]');
  if (details === null) throw new Error("the details row did not open");
  expect(toggle.getAttribute("aria-controls")).toBe(details.id);
  const panel = within(details);
  expect(panel.getByRole("button", { name: "Open" })).toBeTruthy();
  expect(panel.getByRole("button", { name: "Show in folder" })).toBeTruthy();
  expect(panel.getByRole("link", { name: "File journey" }).getAttribute("href")).toBe(
    `/activity/files/${FILE_ID}`,
  );
  expect(panel.getByRole("link", { name: "View batch" }).getAttribute("href")).toBe(
    `/activity/batches/${BATCH_ID}`,
  );
  const facts = factsOf(details);
  expect(facts).toMatchObject({
    Path: "/docs/renamed.txt",
    From: "/docs/old.txt",
    Client: "web",
    Evidence: "server confirmed",
    Size: `${(2048).toLocaleString()} bytes`,
  });
  expect(facts.When).toBe(new Date(renamed.sortAt).toLocaleString());

  fireEvent.click(toggle);
  expect(document.querySelector('[data-slot="activity-details"]')).toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

it("lists what a failed event recorded, and the files a larger one touched", () => {
  mocks.history = feed([
    event({
      action: "share.update",
      evidence: "client_reported",
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

  fireEvent.click(screen.getByRole("button", { name: "Details for Updated share a.txt" }));

  const details = document.querySelector<HTMLElement>('[data-slot="activity-details"]');
  if (details === null) throw new Error("the details row did not open");
  const panel = within(details);
  expect(panel.getByText("Reported by your client")).toBeTruthy();
  expect(panel.getByText("Files involved (2)")).toBeTruthy();
  // Read from the markup: the list sits in a closed disclosure until it is opened. Scoped to
  // that disclosure, since the row's own File journey button links to the same page.
  expect(details.querySelector(`details a[href="/activity/files/${FILE_ID}"]`)?.textContent).toBe(
    "/docs/a.txt",
  );
  expect(panel.getByText("Location unavailable")).toBeTruthy();
  const facts = factsOf(details);
  expect(facts).toMatchObject({
    Evidence: "client reported",
    Result: "not found",
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
});

it("opens a folder in the file browser from the details", async () => {
  mocks.activityFile.mockResolvedValue({ currentPath: "/docs/kept", kind: "dir" });
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Details for Moved to Trash gone" }));
  fireEvent.click(screen.getByRole("button", { name: "Open" }));

  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/files/docs/kept"));
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
  fireEvent.click(theirs.getByRole("button", { name: "Details for Uploaded theirs.txt" }));
  expect(screen.getByRole("button", { name: "Open" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Show in folder" })).toHaveProperty("disabled", true);
  fireEvent.click(theirs.getByRole("button", { name: "Details for Uploaded theirs.txt" }));

  // An event about no file has no item, no location, and nothing to open in its details.
  const emptied = rowOf("Emptied Trash");
  expect(within(emptied).getAllByText("--")).toHaveLength(2);
  fireEvent.click(within(emptied).getByRole("button", { name: "Details for Emptied Trash" }));
  expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  expect(screen.queryByRole("link", { name: "File journey" })).toBeNull();
});

it("keeps what an observation leaves uncertain in the row itself", () => {
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
  expect(rename.queryByText(/success/)).toBeNull();
  expect(within(rowOf("Moved to Trash")).getByText("· failed")).toBeTruthy();

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
  fireEvent.keyDown(await screen.findByRole("option", { name: "office" }), { key: "Enter" });
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
      lastConfirmedAt: null,
      revisionId: null,
    },
  };
  mocks.activityRequest.mockResolvedValue({ id: "e1" });
  renderPage({ fileId: FILE_ID });

  expect(screen.getByRole("heading", { name: "File journey" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "My activity" }).getAttribute("href")).toBe("/activity");
  expect(mocks.historyCalls.at(-1)?.[1]).toBe(`/files/${FILE_ID}/events`);
  expect(screen.getByRole("heading", { name: "renamed.txt" })).toBeTruthy();
  expect(screen.getByText("live")).toBeTruthy();
  expect(
    screen.getByText(
      "ada · Revision records describe changes; earlier file contents are not stored.",
    ),
  ).toBeTruthy();
  expect(screen.getByTestId("journey-details").textContent).toBe(FILE_ID);

  // A row about this file needs no link to the journey it is already on.
  fireEvent.click(screen.getByRole("button", { name: "Details for Renamed renamed.txt" }));
  expect(screen.queryByRole("link", { name: "File journey" })).toBeNull();
  expect(screen.getByRole("link", { name: "View batch" })).toBeTruthy();

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
  expect(
    screen.getByText("Revision records describe changes; earlier file contents are not stored."),
  ).toBeTruthy();
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
