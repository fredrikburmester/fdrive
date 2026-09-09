// @vitest-environment jsdom
import type { SystemSearchResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSystemSearchMock = vi.fn();
const useReembedMock = vi.fn();

vi.mock("@/lib/api/system-queries", () => ({
  useSystemSearch: () => useSystemSearchMock(),
  useReembed: () => useReembedMock(),
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

const { SearchPage } = await import("./search-page");

const CONFIGURED_FIXTURE: SystemSearchResponse = {
  configured: true,
  semantic: {
    configured: true,
    healthy: true,
    model: "intfloat/multilingual-e5-small",
    maxInputLength: 512,
  },
  roots: ["sftpgo"],
  index: { files: 16, withText: 10, chunks: 10, embedded: 10 },
};

function mockConfigured() {
  useSystemSearchMock.mockReturnValue({
    data: CONFIGURED_FIXTURE,
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
    refetch: vi.fn(),
  });
  useReembedMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SearchPage", () => {
  it("declares the feature that gates this page", () => {
    mockConfigured();
    render(<SearchPage />);

    expect(screen.getByTestId("system-page").dataset.feature).toBe("semanticSearch");
  });

  it("renders the semantic status and model", async () => {
    mockConfigured();
    render(<SearchPage />);

    expect(await screen.findByText("Reachable")).toBeTruthy();
    expect(screen.getByText("intfloat/multilingual-e5-small")).toBeTruthy();
    expect(screen.getByText("max input 512 tokens")).toBeTruthy();
  });

  it("renders the index totals as stat cards", async () => {
    mockConfigured();
    render(<SearchPage />);

    await screen.findByText("Files");
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("With text")).toBeTruthy();
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
  });

  it("renders the model, dimension, and re-embed cost descriptions", async () => {
    mockConfigured();
    render(<SearchPage />);

    expect(
      await screen.findByText(
        "Each chunk of text is turned into a 384-dimension vector by this model, so search can rank results by meaning, not just matching words. The badge above shows the model's own limit on how much text it can embed at once.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Re-embed re-extracts and re-embeds every file in every configured root from scratch, not just the embeddings. On a large index this can take a long time and loads the indexer with work.",
      ),
    ).toBeTruthy();
  });

  it("renders the configured roots", async () => {
    mockConfigured();
    render(<SearchPage />);

    expect(await screen.findByText("Roots")).toBeTruthy();
    expect(screen.getByText("sftpgo")).toBeTruthy();
  });

  it("shows Loading while the query has not resolved yet", () => {
    useSystemSearchMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });
    useReembedMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<SearchPage />);

    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows the error state, distinct from Loading, when the query fails", () => {
    const refetch = vi.fn();
    useSystemSearchMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("search sidecar unreachable"),
      dataUpdatedAt: 0,
      refetch,
    });
    useReembedMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<SearchPage />);

    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("search sidecar unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("names the missing variable when semantic search is not configured", async () => {
    useSystemSearchMock.mockReturnValue({
      data: {
        ...CONFIGURED_FIXTURE,
        semantic: { configured: false, healthy: false },
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
      refetch: vi.fn(),
    });
    useReembedMock.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<SearchPage />);

    expect(await screen.findByText("Not configured: set FDRIVE_EMBED_URL.")).toBeTruthy();
  });
});
