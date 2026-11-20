// @vitest-environment jsdom
import type { SystemThumbnailsResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
// rendered for real: it reads the features and the failure history itself,
// which needs a `QueryClient` this test has no reason to set up.
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
    data: { configured: true, reachable: true },
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

  it("says the cache is reachable in the header's badges, with nothing more to explain", async () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    expect(await within(screen.getByTestId("badges")).findByText("Reachable")).toBeTruthy();
    expect(screen.queryByText(/unreachable/)).toBeNull();
    expect(screen.queryByText(/Not configured/)).toBeNull();
  });

  it("puts Rebuild last among the header's actions, as the one primary button", () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    expect(
      within(screen.getByTestId("actions"))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Logs", "Rebuild"]);
  });

  it("keeps Clear thumbnails apart in the footer, beside what clearing keeps", () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    const footer = within(screen.getByTestId("footer"));
    expect(footer.getByRole("button", { name: "Clear thumbnails" })).toBeTruthy();
    expect(
      footer.getByText("Clearing removes cached previews only. Your files are not touched."),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("actions")).queryByRole("button", { name: "Clear thumbnails" }),
    ).toBeNull();
  });

  it("renders the thumbnail count and cache size as headline numbers", async () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    // "Thumbnails" appears twice: the page title (h1) and the number's label.
    expect((await screen.findAllByText("Thumbnails")).length).toBeGreaterThan(1);
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("Cache size")).toBeTruthy();
    expect(screen.getByText("2.5 MB")).toBeTruthy();
  });

  it("shows the progress of a rebuild and of a clear", async () => {
    mockConfigured();
    const job = {
      running: true,
      processed: 1,
      total: 4,
      startedAt: "2026-09-06T12:00:00Z",
      finishedAt: null,
      errors: 0,
    };
    useSystemIndexerMock.mockReturnValue({
      data: {
        configured: true,
        reachable: true,
        stats: { thumbnailRebuild: job, thumbnailClear: { ...job, running: false, processed: 4 } },
      },
      error: null,
      refetch: vi.fn(),
    });
    render(<ThumbnailsPage />);

    expect(await screen.findByText("Thumbnail rebuild")).toBeTruthy();
    expect(screen.getByText("Thumbnail cache clear")).toBeTruthy();
    expect(screen.getAllByRole("status").map((status) => status.textContent)).toEqual([
      "Running · 1 of 4 processed · 0 errors",
      "Completed · 4 of 4 processed · 0 errors",
    ]);
  });

  it("never says Reachable when FDRIVE_THUMBS_DIR is set but the indexer itself is not configured", async () => {
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

    // Both variables are set in mono, as values to copy, so the sentence spans elements.
    const variable = await screen.findByText("FDRIVE_THUMBS_DIR");
    expect(variable.tagName).toBe("CODE");
    expect(variable.parentElement?.textContent).toBe(
      "Not configured: set FDRIVE_THUMBS_DIR and FDRIVE_INDEXER_URL.",
    );
    expect(
      within(screen.getByTestId("badges")).getByText("Not configured", { exact: true }),
    ).toBeTruthy();
    expect(screen.queryByText("Reachable")).toBeNull();
  });

  it("shows the unreachable note, not Reachable, when the indexer is configured but unreachable", async () => {
    mockConfigured();
    useSystemIndexerMock.mockReturnValue({
      data: { configured: true, reachable: false },
      error: null,
      refetch: vi.fn(),
    });

    render(<ThumbnailsPage />);

    expect(await within(screen.getByTestId("badges")).findByText("Unreachable")).toBeTruthy();
    expect(screen.getByText("The indexer that generates thumbnails is unreachable.")).toBeTruthy();
    expect(screen.queryByText("Reachable")).toBeNull();
    // The cache is on disk, so its numbers stay on screen.
    expect(screen.getByText("Cache size")).toBeTruthy();
  });

  it("says nothing about the cache's state until the indexer has answered", () => {
    mockConfigured();
    useSystemIndexerMock.mockReturnValue({ data: undefined, error: null, refetch: vi.fn() });

    render(<ThumbnailsPage />);

    expect(screen.getByTestId("badges").textContent).toBe("");
    expect(screen.queryByText(/Not configured/)).toBeNull();
    expect(screen.getByText("Cache size")).toBeTruthy();
  });

  it("offers a retry when the indexer's own status cannot be read", () => {
    mockConfigured();
    const refetch = vi.fn();
    useSystemIndexerMock.mockReturnValue({
      data: undefined,
      error: new Error("indexer status unavailable"),
      refetch,
    });

    render(<ThumbnailsPage />);

    expect(screen.getByText("indexer status unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Rebuild" })).toHaveProperty("disabled", true);
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
    expect(screen.getByLabelText("Path (optional)")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("switch", { name: "Regenerate existing thumbnails" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(mutate).toHaveBeenCalledWith({ force: true }, expect.anything());
    expect(successToast).toHaveBeenCalledWith("Rebuilding 6 thumbnails…");
    expect(screen.queryByRole("heading", { name: "Rebuild thumbnails" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(mutate).toHaveBeenLastCalledWith({}, expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    fireEvent.change(screen.getByLabelText("Path (optional)"), {
      target: { value: "alice/Photos" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(mutate).toHaveBeenLastCalledWith({ path: "alice/Photos" }, expect.anything());
  });

  it("cancels cache removal, then confirms a global clear", async () => {
    mockConfigured();
    const mutate = vi.fn(
      (_request: unknown, options: { onSuccess: (result: { started: boolean }) => void }) =>
        options.onSuccess({ started: true }),
    );
    useClearThumbnailsMock.mockReturnValue({ mutate, isPending: false });
    render(<ThumbnailsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear thumbnails" }));
    await screen.findByRole("heading", { name: "Clear thumbnail cache?" });
    expect(screen.getByText(/Removes every cached preview/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear thumbnails" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear thumbnails" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Clear thumbnails" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear thumbnails" }));
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
    expect(screen.getByRole("button", { name: "Clear thumbnails" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
