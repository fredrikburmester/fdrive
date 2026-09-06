// @vitest-environment jsdom
import type { SystemOcrResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemOcrMock = vi.fn();
const useUpdateOcrSettingsMock = vi.fn();
const useRunOcrMock = vi.fn();

vi.mock("@/lib/api/system-queries", () => ({
  useSystemOcr: () => useSystemOcrMock(),
  useUpdateOcrSettings: () => useUpdateOcrSettingsMock(),
  useRunOcr: () => useRunOcrMock(),
}));

// See `indexer-page.test.tsx` for why `SystemPage` is stubbed rather than
// rendered for real: its shell chrome needs a `SidebarProvider` and a
// `QueryClient` this test has no reason to set up.
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

const { OcrPage } = await import("./ocr-page");

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
    originalsCount: 12,
    originalsBytes: 1024,
    running: false,
  },
  settings: {
    values: { hour: 3, langs: "swe+eng", excludeGlobs: [], maxMb: 200, keepOriginals: false },
    sources: {
      hour: "default",
      langs: "default",
      excludeGlobs: "default",
      maxMb: "default",
      keepOriginals: "default",
    },
  },
};

const NOT_CONFIGURED_FIXTURE: SystemOcrResponse = {
  configured: false,
  reachable: false,
  settings: CONFIGURED_FIXTURE.settings,
};

function mockConfigured() {
  useSystemOcrMock.mockReturnValue({
    data: CONFIGURED_FIXTURE,
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
  it("renders the last run's stat cards", async () => {
    mockConfigured();
    render(<OcrPage />);

    expect(await screen.findByText("Seen")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("OCR'd")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.getByText("94")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("renders the originals kept and cache size", async () => {
    mockConfigured();
    render(<OcrPage />);

    await screen.findByText("Originals kept");
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("Originals size")).toBeTruthy();
    expect(screen.getByText("1.0 KB")).toBeTruthy();
  });

  it("renders the settings form pre-filled with the fixture's values", async () => {
    mockConfigured();
    render(<OcrPage />);

    expect(await screen.findByLabelText("Languages")).toHaveProperty("value", "swe+eng");
    expect(screen.getByLabelText("Max file size (MB)")).toHaveProperty("value", "200");
  });

  it("renders the Keep originals description explaining reversibility", async () => {
    mockConfigured();
    render(<OcrPage />);

    expect(
      await screen.findByText(
        "When OCR rewrites a PDF to add a text layer, the original file is saved under the OCR state directory so it can be restored. Turning this off saves disk space but makes OCR irreversible.",
      ),
    ).toBeTruthy();
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

    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.queryByText("Seen")).toBeNull();
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
