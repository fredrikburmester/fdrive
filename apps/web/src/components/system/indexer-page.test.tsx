// @vitest-environment jsdom
import type { SystemIndexerResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemIndexerMock = vi.fn();
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
  useUpdateIndexerSettings: () => useUpdateIndexerSettingsMock(),
  useReindex: () => useReindexMock(),
  useClearIndex: () => useClearIndexMock(),
  useSystemMaintenanceBusy: () => useSystemMaintenanceBusyMock(),
}));

// `SystemPage` pulls in the whole shell chrome (sidebar trigger, global
// search) which needs a `SidebarProvider` and a `QueryClient` this test has
// no reason to set up: only its `children` (and `actions`) matter here.
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <div data-testid="actions">{props.actions}</div>
      <div>{props.children}</div>
    </div>
  ),
}));

const { IndexerPage } = await import("./indexer-page");

/** A realistic "configured and reachable" fixture, mirroring the shape the
 * API's `GET /api/v1/system/indexer` actually returns in dev (see the fake
 * indexer's fixtures in `e2e/support/fake-indexer.ts`). */
const CONFIGURED_FIXTURE: SystemIndexerResponse = {
  configured: true,
  reachable: true,
  health: {
    ok: true,
    roots: ["sftpgo"],
    watcher: { sftpgo: true },
    embedOk: true,
    schemaVersion: 1,
  },
  stats: {
    roots: [
      {
        root: "sftpgo",
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
      },
    ],
    thumbnails: 6,
    queueDepth: 0,
    errorsSample: [
      {
        path: "alice/docs/report.pdf",
        error:
          "FileDataError: Failed to open file '/roots/sftpgo/alice/docs/report.pdf' as type pdf.",
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSystemMaintenanceBusyMock.mockReturnValue(false);
});

describe("IndexerPage", () => {
  it("renders the stat cards computed from the configured fixture", async () => {
    mockConfigured();
    render(<IndexerPage />);

    // Files: sum of countsByStatus (3 + 1 + 1 + 10 + 1); with text: indexed + partial.
    // The Files label appears in both the stat card and table header.
    expect((await screen.findAllByText("Files")).length).toBeGreaterThan(0);
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("With text")).toBeTruthy();
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
    expect(screen.getByText("Embedded")).toBeTruthy();
    expect(screen.queryByText("Thumbnails")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rebuild thumbnails" })).toBeNull();
    expect(screen.getByText("Queue depth")).toBeTruthy();
  });

  it("renders one table row per root/status pair from countsByStatus", async () => {
    mockConfigured();
    render(<IndexerPage />);

    await screen.findByText("Counts by status");
    for (const [status, count] of Object.entries(
      CONFIGURED_FIXTURE.stats?.roots[0]?.countsByStatus ?? {},
    )) {
      expect(screen.getByText(status)).toBeTruthy();
      expect(screen.getAllByText(String(count)).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("sftpgo").length).toBeGreaterThan(0);
  });

  it("renders the last scan summary", async () => {
    mockConfigured();
    render(<IndexerPage />);

    await screen.findByText("Last scan");
    expect(screen.getByText(/16 seen/)).toBeTruthy();
    expect(screen.getByText(/0 changed/)).toBeTruthy();
    expect(screen.getByText(/0 deleted/)).toBeTruthy();
    expect(screen.getByText(/0 errors/)).toBeTruthy();
  });

  it("renders the errors sample", async () => {
    mockConfigured();
    render(<IndexerPage />);

    expect(await screen.findByText("Recent errors")).toBeTruthy();
    expect(screen.getByText("alice/docs/report.pdf")).toBeTruthy();
    expect(screen.getByText(/FileDataError/)).toBeTruthy();
  });

  it("renders the settings form pre-filled with the fixture's values", async () => {
    mockConfigured();
    render(<IndexerPage />);

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
    const workers = await screen.findByLabelText("Workers");
    expect(screen.getByText(/Time between scheduled scans/)).toBeTruthy();
    expect(screen.getByText(/Number of files extracted concurrently/)).toBeTruthy();
    fireEvent.change(workers, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(workers).toHaveProperty("value", "4");
    fireEvent.change(workers, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ workers: 7 }), expect.anything());
    expect(successToast).toHaveBeenCalledWith("Indexer settings saved.");
  });

  it("reindex contains no thumbnail toggle", async () => {
    mockConfigured();
    render(<IndexerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reindex…" }));
    expect(await screen.findByRole("heading", { name: "Reindex" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Reindex" })).toBeNull();
  });

  it("keeps the root select controlled when choosing a reindex scope", async () => {
    mockConfigured();
    const mutate = vi.fn();
    useReindexMock.mockReturnValue({ mutate, isPending: false });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<IndexerPage />);
      fireEvent.click(screen.getByRole("button", { name: "Reindex…" }));
      expect(screen.getByRole("button", { name: "Reindex" })).toHaveProperty("disabled", true);
      fireEvent.click(screen.getByLabelText("Root"));
      fireEvent.click(await screen.findByRole("option", { name: "sftpgo" }));
      expect(screen.getByLabelText("Root").textContent).toContain("sftpgo");
      expect(screen.getByRole("button", { name: "Reindex" })).toHaveProperty("disabled", false);
      fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
      expect(mutate).toHaveBeenCalledWith({ root: "sftpgo" }, expect.anything());
      expect(error.mock.calls.flat().join(" ")).not.toMatch(/uncontrolled/i);
    } finally {
      error.mockRestore();
    }
  });

  it("confirms clear scope, cancels without mutation, then submits all roots", async () => {
    mockConfigured();
    const mutate = vi.fn(
      (_request: unknown, options: { onSuccess: (result: { started: boolean }) => void }) =>
        options.onSuccess({ started: true }),
    );
    useClearIndexMock.mockReturnValue({ mutate, isPending: false });
    render(<IndexerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear index…" }));
    await screen.findByRole("heading", { name: "Clear index data?" });
    expect(screen.getByLabelText("Root").textContent).toContain("All roots");
    expect(screen.getByLabelText("Root").textContent).not.toContain("__all__");
    expect(screen.getByText(/Later scheduled scans or file changes/)).toBeTruthy();
    expect(screen.getByLabelText("Path (optional)")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear index…" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Clear index…" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear index" }));
    expect(errorToast).toHaveBeenCalledWith("A maintenance job is already running.");
    expect(screen.getByRole("heading", { name: "Clear index data?" })).toBeTruthy();
  });

  it("disables actions while maintenance is active", () => {
    mockConfigured();
    useSystemMaintenanceBusyMock.mockReturnValue(true);
    render(<IndexerPage />);
    expect(screen.getByRole("button", { name: "Clear index…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reindex…" })).toHaveProperty("disabled", true);
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
});
