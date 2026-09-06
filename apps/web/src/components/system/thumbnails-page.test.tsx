// @vitest-environment jsdom
import type { SystemThumbnailsResponse } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemThumbnailsMock = vi.fn();
const useRebuildThumbnailsMock = vi.fn();

vi.mock("@/lib/api/system-queries", () => ({
  useSystemThumbnails: () => useSystemThumbnailsMock(),
  useRebuildThumbnails: () => useRebuildThumbnailsMock(),
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
    dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
  });
  useRebuildThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThumbnailsPage", () => {
  it("renders the reachable status", async () => {
    mockConfigured();
    render(<ThumbnailsPage />);

    expect(await screen.findByText("Reachable")).toBeTruthy();
    expect(screen.getByText("FDRIVE_THUMBS_DIR is configured.")).toBeTruthy();
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

  it("shows Loading while the query has not resolved yet", () => {
    useSystemThumbnailsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      dataUpdatedAt: 0,
    });
    useRebuildThumbnailsMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<ThumbnailsPage />);

    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});
