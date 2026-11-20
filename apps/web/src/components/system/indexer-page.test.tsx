// @vitest-environment jsdom
import type { SystemFeaturesResponse, SystemIndexerResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useSystemIndexerMock = vi.fn();
const useSystemFeaturesMock = vi.fn();
const useUpdateFeaturesMock = vi.fn();
const useUpdateIndexerSettingsMock = vi.fn();
const useReindexMock = vi.fn();
const useClearIndexMock = vi.fn();
const useSystemMaintenanceBusyMock = vi.fn(() => false);
const successToast = vi.fn();
const errorToast = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => successToast(...args),
    error: (...args: unknown[]) => errorToast(...args),
  },
}));

vi.mock("@/lib/api/system-queries", () => ({
  useSystemIndexer: () => useSystemIndexerMock(),
  useSystemFeatures: () => useSystemFeaturesMock(),
  useUpdateFeatures: () => useUpdateFeaturesMock(),
  useUpdateIndexerSettings: () => useUpdateIndexerSettingsMock(),
  useReindex: () => useReindexMock(),
  useClearIndex: () => useClearIndexMock(),
  useSystemMaintenanceBusy: () => useSystemMaintenanceBusyMock(),
}));

// `SystemPage` reads the features and the failure history itself, which
// needs a `QueryClient` this test has no reason to set up: only what the
// page hands it (badges, actions, content and footer) matters here.
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    badges?: ReactNode;
    actions?: ReactNode;
    footer?: ReactNode;
    feature?: string | readonly string[];
    children: ReactNode;
  }) => (
    <div data-testid="system-page" data-feature={[props.feature ?? []].flat().join(",")}>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <div data-testid="badges">{props.badges}</div>
      <div data-testid="actions">{props.actions}</div>
      <div>{props.children}</div>
      <div data-testid="footer">{props.footer}</div>
    </div>
  ),
}));

const { IndexerPage } = await import("./indexer-page");

/** Opens the header's Settings sheet, where the settings form now lives. */
function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
}

/** A realistic "configured and reachable" fixture, mirroring the shape the
 * API's `GET /api/v1/system/indexer` actually returns in dev (see the fake
 * indexer's fixtures in `e2e/support/fake-indexer.ts`). */
const CONFIGURED_FIXTURE: SystemIndexerResponse = {
  configured: true,
  reachable: true,
  health: {
    ok: true,
    watcher: true,
    embedOk: true,
  },
  stats: {
    countsByStatus: { excluded: 3, none: 1, error: 1, indexed: 10, no_text: 1 },
    chunks: 10,
    chunksEmbedded: 10,
    lastScan: {
      startedAt: "2026-09-06T18:21:28.128513+00:00",
      finishedAt: "2026-09-06T18:21:28.141420+00:00",
      filesSeen: 16,
      filesChanged: 0,
      filesDeleted: 0,
      errors: 0,
    },
    thumbnails: 6,
    queueDepth: 0,
    errorsSample: [
      {
        path: "alice/docs/report.pdf",
        error: "FileDataError: Failed to open file '/data/alice/docs/report.pdf' as type pdf.",
      },
    ],
  },
  settings: {
    values: {
      scanIntervalSeconds: 900,
      workers: 4,
      textExcludeGlobs: [],
      ocrImageGlobs: [],
      tesseractLangs: "swe+eng",
    },
    sources: {
      scanIntervalSeconds: "default",
      workers: "default",
      textExcludeGlobs: "default",
      ocrImageGlobs: "default",
      tesseractLangs: "default",
    },
  },
};

/** Every feature off, as a fresh installation has them. */
const FEATURES: SystemFeaturesResponse = {
  configuration: {
    version: 1,
    revision: 3,
    values: {
      thumbnails: false,
      textSearch: false,
      searchOcr: false,
      semanticSearch: true,
      imageSearch: false,
      pdfOcr: false,
    },
    walkthroughComplete: true,
  },
  source: "settings",
  statuses: [],
};

/** The number a `StatGrid` shows over a label. */
function stat(label: string): string | null | undefined {
  const grid = document.querySelector('[data-slot="stat-grid"]') as HTMLElement;
  return within(grid).getByText(label).parentElement?.querySelector("dd")?.textContent;
}

/** The value a `FactList` shows beside a label. */
function fact(list: HTMLElement, label: string): string | null | undefined {
  return within(list).getByText(label).nextElementSibling?.textContent;
}

function mockConfigured() {
  useSystemIndexerMock.mockReturnValue({
    data: CONFIGURED_FIXTURE,
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
    refetch: vi.fn(),
  });
  useUpdateIndexerSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useReindexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useClearIndexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

beforeEach(() => {
  useSystemFeaturesMock.mockReturnValue({ data: FEATURES });
  useUpdateFeaturesMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  useSystemMaintenanceBusyMock.mockReturnValue(false);
});

/** Sets the clock twelve minutes after the fixture's last scan started. */
function twelveMinutesAfterTheScan() {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-06T18:33:30Z") });
}

describe("IndexerPage", () => {
  it("renders the headline numbers computed from the configured fixture", async () => {
    mockConfigured();
    render(<IndexerPage />);

    // Files: sum of countsByStatus (3 + 1 + 1 + 10 + 1); with text: indexed + partial.
    await screen.findByText("With text");
    expect(stat("Files")).toBe("16");
    expect(stat("With text")).toBe("10");
    expect(stat("Chunks")).toBe("10");
    expect(stat("Embedded")).toBe("10");
    expect(stat("Queue depth")).toBe("0");
    expect(screen.queryByText("Thumbnails")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rebuild thumbnails" })).toBeNull();
  });

  it("says how the indexer is doing in the header's badges", async () => {
    twelveMinutesAfterTheScan();
    mockConfigured();
    render(<IndexerPage />);

    const badges = within(await screen.findByTestId("badges"));
    expect(badges.getByText("Reachable")).toBeTruthy();
    expect(badges.getByText("Watcher on").dataset.tone).toBe("neutral");
    expect(badges.getByText("Scan 12m ago")).toBeTruthy();
  });

  it("marks a stopped watcher as off", async () => {
    mockConfigured();
    useSystemIndexerMock.mockReturnValue({
      data: {
        ...CONFIGURED_FIXTURE,
        health: { ok: true, watcher: false, embedOk: true },
        stats: { ...CONFIGURED_FIXTURE.stats, lastScan: null },
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
      refetch: vi.fn(),
    });
    render(<IndexerPage />);

    const badges = within(await screen.findByTestId("badges"));
    expect(badges.getByText("Watcher off").dataset.tone).toBe("off");
    expect(badges.queryByText(/^Scan /)).toBeNull();
    // No scan has run, so there is nothing to list under "Last scan".
    expect(screen.queryByText("Last scan")).toBeNull();
    expect(screen.getByText("Files by status")).toBeTruthy();
  });

  it("draws one bar per status from countsByStatus, indexed first and errors last", async () => {
    mockConfigured();
    render(<IndexerPage />);

    const section = (await screen.findByRole("heading", { name: "Files by status" })).closest(
      "section",
    ) as HTMLElement;
    const bars = within(section).getAllByRole("listitem");
    expect(bars.map((bar) => bar.textContent)).toEqual([
      "Indexed10",
      "No text1",
      "Excluded3",
      "None1",
      "Error1",
    ]);
    expect(bars[0]?.dataset.tone).toBe("success");
    expect(bars.at(-1)?.dataset.tone).toBe("danger");
    // A bar is its share of all files: 10 of 16 indexed.
    expect(
      (bars[0]?.querySelector('[data-slot="bar-fill"]') as HTMLElement | null)?.style.width,
    ).toBe("62.5%");
  });

  it("names a status it has no label for in plain words", async () => {
    mockConfigured();
    useSystemIndexerMock.mockReturnValue({
      data: {
        ...CONFIGURED_FIXTURE,
        stats: { ...CONFIGURED_FIXTURE.stats, countsByStatus: { "disabled:text": 2, error: 1 } },
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
      refetch: vi.fn(),
    });
    render(<IndexerPage />);

    const section = (await screen.findByRole("heading", { name: "Files by status" })).closest(
      "section",
    ) as HTMLElement;
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((bar) => bar.textContent),
    ).toEqual(["Disabled text2", "Error1"]);
  });

  it("lists the last scan as facts", async () => {
    twelveMinutesAfterTheScan();
    mockConfigured();
    render(<IndexerPage />);

    const section = (await screen.findByRole("heading", { name: "Last scan" })).closest(
      "section",
    ) as HTMLElement;
    expect(fact(section, "Started")).toBe("12m ago");
    expect(fact(section, "Seen")).toBe("16");
    expect(fact(section, "Changed")).toBe("0");
    expect(fact(section, "Deleted")).toBe("0");
    expect(fact(section, "Errors")).toBe("0");
    expect(within(section).getByText("Errors").nextElementSibling?.innerHTML).not.toContain(
      "text-destructive",
    );
  });

  it("writes a last scan's errors in the destructive color", async () => {
    mockConfigured();
    const lastScan = CONFIGURED_FIXTURE.stats?.lastScan;
    useSystemIndexerMock.mockReturnValue({
      data: {
        ...CONFIGURED_FIXTURE,
        stats: { ...CONFIGURED_FIXTURE.stats, lastScan: { ...lastScan, errors: 2 } },
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
      refetch: vi.fn(),
    });
    render(<IndexerPage />);

    const errors = (await screen.findByText("Errors")).nextElementSibling;
    expect(errors?.textContent).toBe("2");
    expect(errors?.innerHTML).toContain("text-destructive");
  });

  it("shows no numbers while the indexer is not reporting", async () => {
    useSystemIndexerMock.mockReturnValue({
      data: { configured: true, reachable: false, settings: CONFIGURED_FIXTURE.settings },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
      refetch: vi.fn(),
    });
    useUpdateIndexerSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useReindexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useClearIndexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    render(<IndexerPage />);

    expect(await screen.findByText("Unreachable")).toBeTruthy();
    expect(screen.getByText(/The indexer is not reporting/)).toBeTruthy();
    expect(document.querySelector('[data-slot="stat-grid"]')).toBeNull();
    expect(screen.queryByText("Files by status")).toBeNull();
    // Nothing to reindex or clear on an indexer that cannot be reached.
    expect(screen.getByRole("button", { name: "Reindex" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Clear index" })).toHaveProperty("disabled", true);
    // Its settings and Search OCR live in fdrive, so they stay editable.
    expect(screen.getByRole("button", { name: "Settings" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("switch", { name: "Enable search ocr" })).toBeTruthy();
  });

  it("offers the Logs sheet instead of an inline errors list", async () => {
    mockConfigured();
    render(<IndexerPage />);

    expect(await screen.findByRole("button", { name: "Logs" })).toBeTruthy();
    expect(screen.queryByText("Recent errors")).toBeNull();
    expect(screen.queryByText("alice/docs/report.pdf")).toBeNull();
  });

  it("renders the settings form pre-filled with the fixture's values", async () => {
    mockConfigured();
    render(<IndexerPage />);
    openSettings();

    expect(await screen.findByLabelText("Scan interval (seconds)")).toHaveProperty("value", "900");
    expect(screen.getByLabelText("Workers")).toHaveProperty("value", "4");
    expect(screen.getByLabelText("Tesseract languages")).toHaveProperty("value", "swe+eng");
  });

  it("shows Loading while the query has not resolved yet", () => {
    useSystemIndexerMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });
    useUpdateIndexerSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useReindexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useClearIndexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<IndexerPage />);

    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("describes all settings and can reset and save an edited draft", async () => {
    mockConfigured();
    const mutate = vi.fn((_value: unknown, options: { onSuccess: () => void }) =>
      options.onSuccess(),
    );
    useUpdateIndexerSettingsMock.mockReturnValue({ mutate, isPending: false });
    render(<IndexerPage />);
    openSettings();
    const workers = await screen.findByLabelText("Workers");
    expect(screen.getByText(/Time between full scans/)).toBeTruthy();
    expect(screen.getByText(/Number of files extracted concurrently/)).toBeTruthy();
    fireEvent.change(workers, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(workers).toHaveProperty("value", "4");
    fireEvent.change(workers, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ workers: 7 }), expect.anything());
    expect(successToast).toHaveBeenCalledWith("Full-text search settings saved.");
  });

  it("keeps an edited draft when the 5-second poll returns new data", async () => {
    mockConfigured();
    const view = render(<IndexerPage />);
    openSettings();
    const workers = await screen.findByLabelText("Workers");
    fireEvent.change(workers, { target: { value: "7" } });

    // A fresh response object, as a refetch produces, with a different
    // server-side value for a field the admin is not editing.
    useSystemIndexerMock.mockReturnValue({
      data: {
        ...CONFIGURED_FIXTURE,
        settings: {
          ...CONFIGURED_FIXTURE.settings,
          values: { ...CONFIGURED_FIXTURE.settings.values, tesseractLangs: "eng" },
        },
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:23:00Z"),
      refetch: vi.fn(),
    });
    view.rerender(<IndexerPage />);

    expect(screen.getByLabelText("Workers")).toHaveProperty("value", "7");
    expect(screen.getByLabelText("Tesseract languages")).toHaveProperty("value", "swe+eng");
  });

  it("declares the features that gate this page", () => {
    mockConfigured();
    render(<IndexerPage />);

    // Full-text search comes first: it is the area's own feature, the one the header's switch
    // and On or Off badge are about.
    expect(screen.getByTestId("system-page").dataset.feature).toBe(
      "textSearch,searchOcr,thumbnails,imageSearch",
    );
  });

  it("puts Reindex last among the header's actions, as the one primary button", () => {
    mockConfigured();
    render(<IndexerPage />);

    const actions = within(screen.getByTestId("actions"))
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(actions).toEqual(["Settings", "Logs", "Reindex"]);
  });

  it("keeps Clear index apart in the footer, beside what clearing keeps", () => {
    mockConfigured();
    render(<IndexerPage />);

    const footer = within(screen.getByTestId("footer"));
    expect(footer.getByRole("button", { name: "Clear index" })).toBeTruthy();
    expect(footer.getByText(/Your files are not touched/)).toBeTruthy();
    expect(
      within(screen.getByTestId("actions")).queryByRole("button", { name: "Clear index" }),
    ).toBeNull();
  });

  it("turns Search OCR on at once, and full-text search with it", () => {
    mockConfigured();
    const mutate = vi.fn();
    useUpdateFeaturesMock.mockReturnValue({ mutate, isPending: false });
    render(<IndexerPage />);

    expect(screen.getByText("Search OCR")).toBeTruthy();
    expect(screen.getByText(/Read text in scans and images/)).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Enable search ocr" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    expect(mutate).toHaveBeenCalledWith(
      {
        revision: 3,
        values: { ...FEATURES.configuration.values, searchOcr: true, textSearch: true },
        walkthroughComplete: true,
        walkthroughStep: 0,
      },
      expect.anything(),
    );
  });

  it("turns Search OCR off alone, and reports a save that failed", () => {
    mockConfigured();
    const on = {
      ...FEATURES.configuration.values,
      textSearch: true,
      searchOcr: true,
    };
    useSystemFeaturesMock.mockReturnValue({
      data: { ...FEATURES, configuration: { ...FEATURES.configuration, values: on } },
    });
    const mutate = vi.fn((_input: unknown, options: { onError: (err: Error) => void }) =>
      options.onError(new Error("The settings changed elsewhere.")),
    );
    useUpdateFeaturesMock.mockReturnValue({ mutate, isPending: false });
    render(<IndexerPage />);

    const toggle = screen.getByRole("switch", { name: "Enable search ocr" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ values: { ...on, searchOcr: false } }),
      expect.anything(),
    );
    expect(errorToast).toHaveBeenCalledWith("The settings changed elsewhere.");
  });

  it("holds the Search OCR switch while a change is being saved, and waits for the features", () => {
    mockConfigured();
    useUpdateFeaturesMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    const view = render(<IndexerPage />);
    const toggle = screen.getByRole("switch", { name: "Enable search ocr" });
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(
      true,
    );

    useSystemFeaturesMock.mockReturnValue({ data: undefined });
    view.rerender(<IndexerPage />);
    expect(screen.queryByRole("switch", { name: "Enable search ocr" })).toBeNull();
  });

  it("reindex contains no thumbnail toggle", async () => {
    mockConfigured();
    render(<IndexerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
    expect(await screen.findByRole("heading", { name: "Reindex" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Reindex" })).toBeNull();
  });

  it("reindexes everything, or the path given", async () => {
    mockConfigured();
    const mutate = vi.fn();
    useReindexMock.mockReturnValue({ mutate, isPending: false });
    render(<IndexerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
    expect(screen.getByRole("button", { name: "Reindex" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
    expect(mutate).toHaveBeenCalledWith({}, expect.anything());
    fireEvent.change(screen.getByLabelText("Path (optional)"), {
      target: { value: " alice/Documents " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
    expect(mutate).toHaveBeenLastCalledWith({ path: "alice/Documents" }, expect.anything());
  });

  it("confirms clear scope, cancels without mutation, then clears everything", async () => {
    mockConfigured();
    const mutate = vi.fn(
      (_request: unknown, options: { onSuccess: (result: { started: boolean }) => void }) =>
        options.onSuccess({ started: true }),
    );
    useClearIndexMock.mockReturnValue({ mutate, isPending: false });
    render(<IndexerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear index" }));
    await screen.findByRole("heading", { name: "Clear index data?" });
    expect(screen.getByText(/Later scheduled scans or file changes/)).toBeTruthy();
    expect(screen.getByLabelText("Path (optional)")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear index" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear index" }));
    expect(mutate).toHaveBeenCalledWith({}, expect.anything());
    expect(successToast).toHaveBeenCalledWith("Index clear started.");
    expect(screen.queryByRole("heading", { name: "Clear index data?" })).toBeNull();
  });

  it("keeps clear confirmation open and reports a rejected request", async () => {
    mockConfigured();
    useClearIndexMock.mockReturnValue({
      mutate: (_request: unknown, options: { onError: (err: Error) => void }) =>
        options.onError(new Error("A maintenance job is already running.")),
      isPending: false,
    });
    render(<IndexerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear index" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear index" }));
    expect(errorToast).toHaveBeenCalledWith("A maintenance job is already running.");
    expect(screen.getByRole("heading", { name: "Clear index data?" })).toBeTruthy();
  });

  it("disables actions while maintenance is active", () => {
    mockConfigured();
    useSystemMaintenanceBusyMock.mockReturnValue(true);
    render(<IndexerPage />);
    expect(screen.getByRole("button", { name: "Clear index" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reindex" })).toHaveProperty("disabled", true);
  });

  it("shows the error state, distinct from Loading, when the query fails", () => {
    const refetch = vi.fn();
    useSystemIndexerMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("indexer unreachable"),
      dataUpdatedAt: 0,
      refetch,
    });
    useUpdateIndexerSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useReindexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useClearIndexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<IndexerPage />);

    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("indexer unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("names the missing variables when the indexer is not configured", async () => {
    useSystemIndexerMock.mockReturnValue({
      data: { configured: false, reachable: false, settings: CONFIGURED_FIXTURE.settings },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
      refetch: vi.fn(),
    });
    useUpdateIndexerSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useReindexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useClearIndexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<IndexerPage />);

    // The variable is set in mono, as a value to copy, so the sentence spans two elements.
    const variable = await screen.findByText("FDRIVE_INDEXER_URL");
    expect(variable.tagName).toBe("CODE");
    expect(variable.parentElement?.textContent).toBe("Not configured: set FDRIVE_INDEXER_URL.");
    expect(within(screen.getByTestId("badges")).getByText("Not configured")).toBeTruthy();
    expect(document.querySelector('[data-slot="stat-grid"]')).toBeNull();
  });
});
