// @vitest-environment jsdom
import type { SystemIndexerResponse } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemIndexerMock = vi.fn();
const useUpdateIndexerSettingsMock = vi.fn();
const useReindexMock = vi.fn();
const useRebuildIndexerThumbnailsMock = vi.fn();

vi.mock("@/lib/api/system-queries", () => ({
  useSystemIndexer: () => useSystemIndexerMock(),
  useUpdateIndexerSettings: () => useUpdateIndexerSettingsMock(),
  useReindex: () => useReindexMock(),
  useRebuildIndexerThumbnails: () => useRebuildIndexerThumbnailsMock(),
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
    dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
  });
  useUpdateIndexerSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useReindexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useRebuildIndexerThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IndexerPage", () => {
  it("renders the stat cards computed from the configured fixture", async () => {
    mockConfigured();
    render(<IndexerPage />);

    // Files: sum of countsByStatus (3 + 1 + 1 + 10 + 1); with text: indexed + partial.
    // "Files" and "Thumbnails" each appear twice (a stat card label and,
    // respectively, the counts-by-status table header and the page title),
    // so these use getAllByText rather than the single-match getByText.
    expect((await screen.findAllByText("Files")).length).toBeGreaterThan(0);
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("With text")).toBeTruthy();
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
    expect(screen.getByText("Embedded")).toBeTruthy();
    expect(screen.getAllByText("Thumbnails").length).toBeGreaterThan(0);
    expect(screen.getByText("6")).toBeTruthy();
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
    useSystemIndexerMock.mockReturnValue({ data: undefined, isLoading: true, dataUpdatedAt: 0 });
    useUpdateIndexerSettingsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useReindexMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useRebuildIndexerThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<IndexerPage />);

    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});
