// @vitest-environment jsdom
import type { SystemSearchResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const { SearchPage } = await import("./search-page");

const CONFIGURED_FIXTURE: SystemSearchResponse = {
  configured: true,
  semantic: {
    configured: true,
    healthy: true,
    model: "intfloat/multilingual-e5-small",
    maxInputLength: 512,
  },
  index: { files: 16, withText: 10, chunks: 10, embedded: 10 },
};

function mockConfigured(overrides: Partial<SystemSearchResponse> = {}) {
  useSystemSearchMock.mockReturnValue({
    data: { ...CONFIGURED_FIXTURE, ...overrides },
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.parse("2026-09-06T18:22:00Z"),
    refetch: vi.fn(),
  });
  useReembedMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

/** The value a `FactList` shows beside a label. */
function fact(label: string): string | null | undefined {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
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

  it("shows the model's state and name as badges in the header", async () => {
    mockConfigured();
    render(<SearchPage />);

    const badges = within(screen.getByTestId("badges"));
    expect(await badges.findByText("Reachable")).toBeTruthy();
    expect(badges.getByText("intfloat/multilingual-e5-small")).toBeTruthy();
  });

  it("renders the index totals as headline numbers", async () => {
    mockConfigured();
    render(<SearchPage />);

    await screen.findByText("Files");
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("With text")).toBeTruthy();
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
  });

  it("splits the chunks into embedded and pending", () => {
    mockConfigured({ index: { files: 16, withText: 10, chunks: 12, embedded: 9 } });
    render(<SearchPage />);

    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Embedded9", "Pending3"]);
  });

  it("lists the model, its dimensions and its input limit as facts", () => {
    mockConfigured();
    render(<SearchPage />);

    expect(fact("Model")).toBe("intfloat/multilingual-e5-small");
    expect(fact("Dimensions")).toBe("384");
    expect(fact("Max input")).toBe("512 tokens");
    expect(
      screen.getByText(
        "Each chunk of text becomes a vector, so search can rank results by meaning, not just matching words.",
      ),
    ).toBeTruthy();
  });

  it("says what re-embedding costs in the sheet's footer", () => {
    mockConfigured();
    render(<SearchPage />);

    expect(screen.getByTestId("footer").textContent).toBe(
      "Re-embed re-extracts and re-embeds every file from scratch. On a large index this can take a long time.",
    );
  });

  it("asks before re-embedding, then marks every file", async () => {
    mockConfigured();
    const mutate = vi.fn();
    useReembedMock.mockReturnValue({ mutate, isPending: false });
    render(<SearchPage />);

    fireEvent.click(screen.getByRole("button", { name: "Re-embed" }));
    expect(await screen.findByRole("heading", { name: "Re-embed everything?" })).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Re-embed" }));
    expect(mutate).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it("does not offer re-embedding while search is not configured", () => {
    mockConfigured({ configured: false });
    render(<SearchPage />);

    expect(screen.getByRole("button", { name: "Re-embed" })).toHaveProperty("disabled", true);
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
    mockConfigured({ semantic: { configured: false, healthy: false } });
    render(<SearchPage />);

    expect(await screen.findByText("Not configured", { selector: "span" })).toBeTruthy();
    expect(
      screen.getByText((_, node) => node?.textContent === "Not configured: set FDRIVE_ML_URL."),
    ).toBeTruthy();
  });

  it("says the model is unreachable and keeps the index numbers on screen", () => {
    mockConfigured({ semantic: { configured: true, healthy: false } });
    render(<SearchPage />);

    expect(within(screen.getByTestId("badges")).getByText("Unreachable")).toBeTruthy();
    expect(
      screen.getByText(
        "The embedding model is unreachable. Its name and limit show here when it answers again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Model", { selector: "dt" })).toBeNull();
    expect(screen.getByText("16")).toBeTruthy();
  });
});
