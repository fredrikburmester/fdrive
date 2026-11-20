// @vitest-environment jsdom
import type { OcrStats, SystemOcrResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemOcrMock = vi.fn();
const useUpdateOcrSettingsMock = vi.fn();
const useRunOcrMock = vi.fn();

vi.mock("@/lib/api/system-queries", () => ({
  useSystemOcr: () => useSystemOcrMock(),
  useUpdateOcrSettings: () => useUpdateOcrSettingsMock(),
  useRunOcr: () => useRunOcrMock(),
  // The kept-originals sheet only queries once opened; these exist so its
  // module-level imports resolve against this mock.
  OCR_ORIGINALS_PAGE_SIZE: 25,
  useOcrOriginals: () => ({ data: undefined, isPending: true, isError: false }),
  useRestoreOcrOriginal: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteOcrOriginal: () => ({ mutate: vi.fn(), isPending: false }),
}));

// See `indexer-page.test.tsx` for why `SystemPage` is stubbed rather than
// rendered for real: its shell chrome needs a `SidebarProvider` and a
// `QueryClient` this test has no reason to set up.
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    badges?: ReactNode;
    actions?: ReactNode;
    feature?: string | readonly string[];
    children: ReactNode;
  }) => (
    <div data-testid="system-page" data-feature={[props.feature ?? []].flat().join(",")}>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <div data-testid="badges">{props.badges}</div>
      <div data-testid="actions">{props.actions}</div>
      <div>{props.children}</div>
    </div>
  ),
}));

const { OcrPage } = await import("./ocr-page");

/** Opens the header's Settings sheet, where the settings form now lives. */
function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
}

/** The value a `FactList` shows beside a label. */
function fact(label: string): string | null | undefined {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
}

/** The sheet's status badges, which sit in its header. */
function badges() {
  return within(screen.getByTestId("badges"));
}

const CONFIGURED_FIXTURE: SystemOcrResponse = {
  configured: true,
  reachable: true,
  health: { ok: true, running: false },
  stats: {
    lastRun: {
      startedAt: "2026-09-06T03:00:00.000000+00:00",
      finishedAt: "2026-09-06T03:10:00.000000+00:00",
      seen: 100,
      ocred: 5,
      skipped: 94,
      failed: 1,
    },
    nextRunAt: "2026-09-07T03:00:00+00:00",
    scheduleHour: 3,
    langs: "swe+eng",
    excludeGlobs: [],
    maxMb: 200,
    keepOriginals: false,
    originalsRetentionDays: 0,
    originalsCount: 12,
    originalsBytes: 1024,
    running: false,
  },
  settings: {
    values: {
      hour: 3,
      langs: "swe+eng",
      excludeGlobs: [],
      maxMb: 200,
      keepOriginals: false,
      originalsRetentionDays: 0,
    },
    sources: {
      hour: "default",
      langs: "default",
      excludeGlobs: "default",
      maxMb: "default",
      keepOriginals: "default",
      originalsRetentionDays: "default",
    },
  },
};

const NOT_CONFIGURED_FIXTURE: SystemOcrResponse = {
  configured: false,
  reachable: false,
  settings: CONFIGURED_FIXTURE.settings,
};

function mockConfigured(overrides: Partial<SystemOcrResponse> = {}) {
  useSystemOcrMock.mockReturnValue({
    data: { ...CONFIGURED_FIXTURE, ...overrides },
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
    refetch: vi.fn(),
  });
  useUpdateOcrSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useRunOcrMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OcrPage", () => {
  it("shows how the PDFs the last run saw were handled", () => {
    mockConfigured();
    render(<OcrPage />);

    expect(screen.getByText(/^Started .+ · 100 PDFs seen$/)).toBeTruthy();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["OCR'd5", "Skipped94", "Failed1"]);
    // A failed file is the one row that is written in red.
    expect(rows.map((row) => row.dataset.tone)).toEqual(["success", "neutral", "danger"]);
  });

  it("says so when OCR has never run", () => {
    mockConfigured({
      stats: { ...(CONFIGURED_FIXTURE.stats as OcrStats), lastRun: null },
    });
    render(<OcrPage />);

    expect(screen.getByText("OCR has not run yet.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders the originals kept and their size as headline numbers", async () => {
    mockConfigured();
    render(<OcrPage />);

    await screen.findByText("Originals kept");
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("Originals size")).toBeTruthy();
    expect(screen.getByText("1.0 KB")).toBeTruthy();
  });

  it("shows the service's state as a badge and the schedule as facts", () => {
    mockConfigured();
    render(<OcrPage />);

    expect(badges().getByText("Reachable")).toBeTruthy();
    expect(badges().queryByText("Running now")).toBeNull();
    expect(fact("Runs")).toBe("Nightly at 03:00");
    expect(fact("Next run")).toBeTruthy();
  });

  it("says in the header when a run is in progress", () => {
    mockConfigured({
      stats: { ...(CONFIGURED_FIXTURE.stats as OcrStats), running: true },
    });
    render(<OcrPage />);

    expect(badges().getByText("Running now")).toBeTruthy();
  });

  it("asks before starting a run outside the schedule", async () => {
    mockConfigured();
    const mutate = vi.fn();
    useRunOcrMock.mockReturnValue({ mutate, isPending: false });
    render(<OcrPage />);

    fireEvent.click(screen.getByRole("button", { name: "Run OCR" }));
    expect(await screen.findByRole("heading", { name: "Run OCR now?" })).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run OCR" }));
    expect(mutate).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it("keeps the schedule on screen and blocks the originals while the service is unreachable", () => {
    mockConfigured({ reachable: false, health: undefined, stats: undefined });
    render(<OcrPage />);

    expect(badges().getByText("Unreachable")).toBeTruthy();
    expect(
      screen.getByText(
        "The OCR service is not reporting. Its last run and the originals it keeps show here when it answers again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Originals kept")).toBeNull();
    expect(screen.queryByText("Last run")).toBeNull();
    expect(fact("Runs")).toBe("Nightly at 03:00");
    expect(screen.getByRole("button", { name: "Manage" })).toHaveProperty("disabled", true);
  });

  it("renders the settings form pre-filled with the fixture's values", async () => {
    mockConfigured();
    render(<OcrPage />);
    openSettings();

    expect(await screen.findByLabelText("Languages")).toHaveProperty("value", "swe+eng");
    expect(screen.getByLabelText("Max file size (MB)")).toHaveProperty("value", "200");
  });

  it("renders the Keep originals description explaining reversibility", async () => {
    mockConfigured();
    render(<OcrPage />);
    openSettings();

    expect(
      await screen.findByText(
        "When OCR rewrites a PDF to add a text layer, the file it replaced is kept, and can be put back from Kept originals. Turning this off saves disk space but makes every later rewrite irreversible.",
      ),
    ).toBeTruthy();
  });

  it("offers a retention window that keeps originals forever at zero", async () => {
    mockConfigured();
    render(<OcrPage />);
    openSettings();

    const field = await screen.findByLabelText("Keep originals for (days)");
    expect((field as HTMLInputElement).value).toBe("0");
    expect(
      screen.getByText("Each pass deletes kept originals older than this. 0 keeps them forever."),
    ).toBeTruthy();
  });

  it("offers managing kept originals alongside their totals", async () => {
    mockConfigured();
    render(<OcrPage />);

    expect(await screen.findByText("Kept originals")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();
  });

  it("says plainly when rewrites are no longer reversible", async () => {
    mockConfigured({
      settings: {
        ...CONFIGURED_FIXTURE.settings,
        values: { ...CONFIGURED_FIXTURE.settings.values, keepOriginals: false },
      },
    });
    render(<OcrPage />);

    expect(
      await screen.findByText(
        "Originals are not being kept, so rewrites from now on cannot be undone.",
      ),
    ).toBeTruthy();
  });

  it("keeps an edited draft when the 5-second poll returns new data", async () => {
    mockConfigured();
    const view = render(<OcrPage />);
    openSettings();
    const langs = await screen.findByLabelText("Languages");
    // The closed Run hour trigger shows the formatted hour, not the raw value.
    expect(
      screen.getByRole("combobox", { name: "Run hour" }).querySelector('[data-slot="select-value"]')
        ?.textContent,
    ).toBe("03:00");
    fireEvent.change(langs, { target: { value: "deu" } });

    useSystemOcrMock.mockReturnValue({
      data: {
        ...CONFIGURED_FIXTURE,
        settings: {
          ...CONFIGURED_FIXTURE.settings,
          values: { ...CONFIGURED_FIXTURE.settings.values, maxMb: 400 },
        },
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:23:00Z"),
      refetch: vi.fn(),
    });
    view.rerender(<OcrPage />);

    expect(screen.getByLabelText("Languages")).toHaveProperty("value", "deu");
    expect(screen.getByLabelText("Max file size (MB)")).toHaveProperty("value", "200");
  });

  it("declares the feature that gates this page", () => {
    mockConfigured();
    render(<OcrPage />);

    expect(screen.getByTestId("system-page").dataset.feature).toBe("pdfOcr");
  });

  it("keeps the not-configured branch for a sidecar with no FDRIVE_OCR_URL", () => {
    useSystemOcrMock.mockReturnValue({
      data: NOT_CONFIGURED_FIXTURE,
      isLoading: false,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });
    useUpdateOcrSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useRunOcrMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<OcrPage />);

    expect(badges().getByText("Not configured")).toBeTruthy();
    expect(screen.getByText("FDRIVE_OCR_URL")).toBeTruthy();
    expect(screen.queryByText("Originals kept")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run OCR" })).toBeNull();
  });

  it("shows Loading while the query has not resolved yet", () => {
    useSystemOcrMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });
    useUpdateOcrSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useRunOcrMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<OcrPage />);

    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows the error state, distinct from Loading, when the query fails", () => {
    const refetch = vi.fn();
    useSystemOcrMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("OCR service unreachable"),
      dataUpdatedAt: 0,
      refetch,
    });
    useUpdateOcrSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useRunOcrMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<OcrPage />);

    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("OCR service unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
