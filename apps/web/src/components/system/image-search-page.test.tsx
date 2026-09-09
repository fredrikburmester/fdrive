// @vitest-environment jsdom
import type { SystemImageSearchResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useSystemImageSearchMock = vi.fn();
const useRebuildImageSearchMock = vi.fn();
const useClearImageSearchMock = vi.fn();
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
  useSystemImageSearch: () => useSystemImageSearchMock(),
  useRebuildImageSearch: () => useRebuildImageSearchMock(),
  useClearImageSearch: () => useClearImageSearchMock(),
  useSystemMaintenanceBusy: () => useSystemMaintenanceBusyMock(),
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

const { ImageSearchPage } = await import("./image-search-page");

const HEALTHY_FIXTURE: SystemImageSearchResponse = {
  configured: true,
  healthy: true,
  model: "siglip2-base",
  dim: 1024,
  embedded: 42,
  embeddedModel: "siglip2-base",
};

function mockHealthy(overrides: Partial<SystemImageSearchResponse> = {}) {
  useSystemImageSearchMock.mockReturnValue({
    data: { ...HEALTHY_FIXTURE, ...overrides },
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.parse("2026-09-07T12:00:00Z"),
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  useRebuildImageSearchMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useClearImageSearchMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useSystemMaintenanceBusyMock.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImageSearchPage", () => {
  it("declares the feature that gates this page", () => {
    mockHealthy();
    render(<ImageSearchPage />);

    expect(screen.getByTestId("system-page").dataset.feature).toBe("imageSearch");
  });

  it("shows Loading while the query has not resolved yet", () => {
    useSystemImageSearchMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });
    render(<ImageSearchPage />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows the error state, distinct from Loading, when the query fails", () => {
    const refetch = vi.fn();
    useSystemImageSearchMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("sidecar unreachable"),
      dataUpdatedAt: 0,
      refetch,
    });
    render(<ImageSearchPage />);
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("sidecar unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("renders Not configured with the variable name when unset", () => {
    useSystemImageSearchMock.mockReturnValue({
      data: { configured: false, healthy: false, embedded: 0, embeddedModel: null },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-07T12:00:00Z"),
      refetch: vi.fn(),
    });
    render(<ImageSearchPage />);
    expect(screen.getByText("Not configured", { exact: true })).toBeTruthy();
    expect(screen.getByText("Not configured: set FDRIVE_IMAGE_EMBED_URL.")).toBeTruthy();
  });

  it("renders Unreachable when configured but the sidecar cannot be reached", () => {
    useSystemImageSearchMock.mockReturnValue({
      data: { configured: true, healthy: false, embedded: 0, embeddedModel: null },
      isLoading: false,
      error: null,
      dataUpdatedAt: Date.parse("2026-09-07T12:00:00Z"),
      refetch: vi.fn(),
    });
    render(<ImageSearchPage />);
    expect(screen.getByText("Unreachable")).toBeTruthy();
    expect(screen.getByText("The image-embedding sidecar is unreachable.")).toBeTruthy();
  });

  it("renders Reachable with the model and dimension when healthy", () => {
    mockHealthy();
    render(<ImageSearchPage />);
    expect(screen.getByText("Reachable")).toBeTruthy();
    expect(screen.getByText("Reachable. Model siglip2-base, dimension 1024.")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("flags a model mismatch between the sidecar's model and the embedded rows", () => {
    mockHealthy({ model: "siglip2-large", embeddedModel: "siglip2-base" });
    render(<ImageSearchPage />);
    expect(screen.getByText("Model mismatch")).toBeTruthy();
    expect(
      screen.getByText("The sidecar now runs siglip2-large. Force rebuild to replace these rows."),
    ).toBeTruthy();
  });

  it("does not flag a mismatch when nothing has been embedded yet", () => {
    mockHealthy({ embeddedModel: null });
    render(<ImageSearchPage />);
    expect(screen.queryByText("Model mismatch")).toBeNull();
  });

  it("rebuilds missing embeddings by default and force is opt in", async () => {
    mockHealthy();
    const mutate = vi.fn(
      (
        _request: unknown,
        options: { onSuccess: (result: { started: boolean; total: number }) => void },
      ) => options.onSuccess({ started: true, total: 5 }),
    );
    useRebuildImageSearchMock.mockReturnValue({ mutate, isPending: false });
    render(<ImageSearchPage />);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await screen.findByRole("heading", { name: "Rebuild image embeddings" });
    fireEvent.click(screen.getByRole("switch", { name: "Replace rows from other models" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(mutate).toHaveBeenCalledWith({ force: true }, expect.anything());
    expect(successToast).toHaveBeenCalledWith("Rebuilding 5 image embeddings…");
    expect(screen.queryByRole("heading", { name: "Rebuild image embeddings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(mutate).toHaveBeenLastCalledWith({}, expect.anything());
  });

  it("shows a 409 conflict message from a running rebuild", async () => {
    mockHealthy();
    const { ApiClientError } = await import("@fdrive/contracts");
    useRebuildImageSearchMock.mockReturnValue({
      mutate: (_request: unknown, options: { onError: (error: unknown) => void }) =>
        options.onError(new ApiClientError("conflict", "busy", 409)),
      isPending: false,
    });
    render(<ImageSearchPage />);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await screen.findByRole("heading", { name: "Rebuild image embeddings" });
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(errorToast).toHaveBeenCalledWith(
      "A maintenance job is already running. Wait for it to finish, then try again.",
    );
  });

  it("cancels the clear confirmation, then confirms a clear", () => {
    mockHealthy();
    const mutate = vi.fn(
      (_request: unknown, options: { onSuccess: (result: { started: boolean }) => void }) =>
        options.onSuccess({ started: true }),
    );
    useClearImageSearchMock.mockReturnValue({ mutate, isPending: false });
    render(<ImageSearchPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear embeddings" }));
    expect(screen.getByRole("heading", { name: "Clear image embeddings?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear embeddings" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear embeddings" }));
    expect(mutate).toHaveBeenCalledWith(undefined, expect.anything());
    expect(successToast).toHaveBeenCalledWith("Image embedding clear started.");
  });

  it("retains the dialog when clearing fails", () => {
    mockHealthy();
    useClearImageSearchMock.mockReturnValue({
      mutate: (_request: unknown, options: { onError: (error: Error) => void }) =>
        options.onError(new Error("busy")),
      isPending: false,
    });
    render(<ImageSearchPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear embeddings" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear embeddings" }));
    expect(errorToast).toHaveBeenCalledWith("busy");
    expect(screen.getByRole("heading", { name: "Clear image embeddings?" })).toBeTruthy();
  });

  it.each(["busy", "unreachable", "pending"])("disables conflicting actions when %s", (state) => {
    mockHealthy();
    if (state === "busy") useSystemMaintenanceBusyMock.mockReturnValue(true);
    if (state === "unreachable") mockHealthy({ healthy: false });
    if (state === "pending")
      useClearImageSearchMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    render(<ImageSearchPage />);
    expect(screen.getByRole("button", { name: "Rebuild" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Clear embeddings" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("renders progress for a running rebuild and clear job", () => {
    mockHealthy({
      rebuild: {
        running: true,
        startedAt: "2026-09-07T12:00:00Z",
        finishedAt: null,
        processed: 1,
        total: 5,
        errors: 0,
      },
      clear: {
        running: false,
        startedAt: "2026-09-07T11:00:00Z",
        finishedAt: "2026-09-07T11:05:00Z",
        processed: 5,
        total: 5,
        errors: 1,
      },
    });
    render(<ImageSearchPage />);
    expect(screen.getByText("Image embedding rebuild")).toBeTruthy();
    expect(screen.getByText("Image embedding clear")).toBeTruthy();
  });
});
