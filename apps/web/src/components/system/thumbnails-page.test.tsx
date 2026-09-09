// @vitest-environment jsdom
import type { SystemThumbnailsResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useSystemThumbnailsMock = vi.fn();
const useRebuildIndexerThumbnailsMock = vi.fn();
const useClearThumbnailsMock = vi.fn();
const useSystemIndexerMock = vi.fn();
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
  useClearThumbnails: () => useClearThumbnailsMock(),
  useSystemMaintenanceBusy: () => useSystemMaintenanceBusyMock(),
  useSystemThumbnails: () => useSystemThumbnailsMock(),
  useRebuildIndexerThumbnails: () => useRebuildIndexerThumbnailsMock(),
}));

// See `indexer-page.test.tsx` for why `SystemPage` is stubbed rather than
// rendered for real: its shell chrome needs a `SidebarProvider` and a
// `QueryClient` this test has no reason to set up.
vi.mock("./system-page", () => ({
  SystemPage: (props: {
    title: string;
    description: string;
    actions?: ReactNode;
    feature?: string | readonly string[];
    children: ReactNode;
  }) => (
    <div data-testid="system-page" data-feature={[props.feature ?? []].flat().join(",")}>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      <div data-testid="actions">{props.actions}</div>
      <div>{props.children}</div>
    </div>
  ),
}));

const { ThumbnailsPage } = await import("./thumbnails-page");

const CONFIGURED_FIXTURE: SystemThumbnailsResponse = {
  configured: true,
  count: 6,
  bytes: 2_621_440,
};

function mockConfigured() {
  useSystemThumbnailsMock.mockReturnValue({
    data: CONFIGURED_FIXTURE,
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
    refetch: vi.fn(),
  });
  useRebuildIndexerThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

beforeEach(() => {
  useSystemIndexerMock.mockReturnValue({
    data: { configured: true, reachable: true, health: { roots: ["sftpgo"] } },
    error: null,
    refetch: vi.fn(),
  });
  useClearThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useSystemMaintenanceBusyMock.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThumbnailsPage", () => {
  it("declares the feature that gates this page", () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    expect(screen.getByTestId("system-page").dataset.feature).toBe("thumbnails");
  });

  it("renders the reachable status", async () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    expect(await screen.findByText("Reachable")).toBeTruthy();
    expect(screen.getByText("Thumbnail cache is available.")).toBeTruthy();
  });

  it("renders the rebuild-versus-clear description", async () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    expect(await screen.findByText(/Clear cache removes previews globally/)).toBeTruthy();
  });

  it("renders the thumbnail count and cache size stat cards", async () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    // "Thumbnails" appears twice: the page title (h1) and the stat card label.
    expect((await screen.findAllByText("Thumbnails")).length).toBeGreaterThan(1);
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("Cache size")).toBeTruthy();
    expect(screen.getByText("2.5 MB")).toBeTruthy();
  });

  it("never shows 'Thumbnail cache is available.' next to a Not configured badge: FDRIVE_THUMBS_DIR set but the indexer itself is not configured", async () => {
    useSystemThumbnailsMock.mockReturnValue({
      data: CONFIGURED_FIXTURE,
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
      refetch: vi.fn(),
    });
    useRebuildIndexerThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    useSystemIndexerMock.mockReturnValue({
      data: { configured: false, reachable: false },
      error: null,
      refetch: vi.fn(),
    });

    render(<ThumbnailsPage />);

    expect(
      await screen.findByText("Not configured: set FDRIVE_THUMBS_DIR and FDRIVE_INDEXER_URL."),
    ).toBeTruthy();
    expect(screen.getByText("Not configured", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Thumbnail cache is available.")).toBeNull();
  });

  it("shows the unreachable description, not 'available', when the indexer is configured but unreachable", async () => {
    mockConfigured();
    useSystemIndexerMock.mockReturnValue({
      data: { configured: true, reachable: false },
      error: null,
      refetch: vi.fn(),
    });

    render(<ThumbnailsPage />);

    expect(await screen.findByText("Unreachable")).toBeTruthy();
    expect(screen.getByText("The indexer that generates thumbnails is unreachable.")).toBeTruthy();
    expect(screen.queryByText("Thumbnail cache is available.")).toBeNull();
  });

  it("shows Loading while the query has not resolved yet", () => {
    useSystemThumbnailsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });
    useRebuildIndexerThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<ThumbnailsPage />);

    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows the error state, distinct from Loading, when the query fails", () => {
    const refetch = vi.fn();
    useSystemThumbnailsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("thumbnails cache unreachable"),
      dataUpdatedAt: 0,
      refetch,
    });
    useRebuildIndexerThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<ThumbnailsPage />);

    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("thumbnails cache unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
  it("rebuilds missing previews by default and force is opt in", async () => {
    mockConfigured();
    const mutate = vi.fn(
      (
        _request: unknown,
        options: { onSuccess: (result: { started: boolean; total: number }) => void },
      ) => options.onSuccess({ started: true, total: 6 }),
    );
    useRebuildIndexerThumbnailsMock.mockReturnValue({ mutate, isPending: false });
    render(<ThumbnailsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await screen.findByRole("heading", { name: "Rebuild thumbnails" });
    expect(screen.getByLabelText("Root").textContent).toContain("All roots");
    expect(screen.getByLabelText("Root").textContent).not.toContain("__all__");
    expect(screen.getByLabelText("Path (optional)")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("switch", { name: "Regenerate existing thumbnails" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(mutate).toHaveBeenCalledWith({ force: true }, expect.anything());
    expect(successToast).toHaveBeenCalledWith("Rebuilding 6 thumbnails…");
    expect(screen.queryByRole("heading", { name: "Rebuild thumbnails" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(mutate).toHaveBeenLastCalledWith({}, expect.anything());
  });

  it("cancels cache removal, then confirms a global clear", async () => {
    mockConfigured();
    const mutate = vi.fn(
      (_request: unknown, options: { onSuccess: (result: { started: boolean }) => void }) =>
        options.onSuccess({ started: true }),
    );
    useClearThumbnailsMock.mockReturnValue({ mutate, isPending: false });
    render(<ThumbnailsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
    await screen.findByRole("heading", { name: "Clear thumbnail cache?" });
    expect(screen.getByText(/Removes cached previews for all roots/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
    expect(mutate).toHaveBeenCalledWith(undefined, expect.anything());
    expect(successToast).toHaveBeenCalledWith("Thumbnail cache clear started.");
  });

  it("retains the dialog when clearing fails", () => {
    mockConfigured();
    useClearThumbnailsMock.mockReturnValue({
      mutate: (_request: unknown, options: { onError: (error: Error) => void }) =>
        options.onError(new Error("busy")),
      isPending: false,
    });
    render(<ThumbnailsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
    expect(errorToast).toHaveBeenCalledWith("busy");
    expect(screen.getByRole("heading", { name: "Clear thumbnail cache?" })).toBeTruthy();
  });

  it.each(["busy", "unreachable", "pending"])("disables conflicting actions when %s", (state) => {
    mockConfigured();
    if (state === "busy") useSystemMaintenanceBusyMock.mockReturnValue(true);
    if (state === "unreachable")
      useSystemIndexerMock.mockReturnValue({ data: { configured: true, reachable: false } });
    if (state === "pending")
      useClearThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    render(<ThumbnailsPage />);
    expect(screen.getByRole("button", { name: "Rebuild" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Clear cache" })).toHaveProperty("disabled", true);
  });
});
