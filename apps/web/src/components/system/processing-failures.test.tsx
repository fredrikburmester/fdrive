// @vitest-environment jsdom
import type { ProcessingFailuresResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const read = vi.fn();
const retry = vi.fn();
const success = vi.fn();
const error = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    processingFailures: (...args: unknown[]) => read(...args),
    retryProcessingFailures: (...args: unknown[]) => retry(...args),
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => success(...args),
    error: (...args: unknown[]) => error(...args),
  },
}));
const { ProcessingFailures } = await import("./processing-failures");
const at = "2026-09-13T08:00:00Z";
const response: ProcessingFailuresResponse = {
  entries: [
    {
      id: 8,
      feature: "thumbnails",
      root: "photos",
      path: "broken.png",
      code: "DecodeError",
      message: "Cannot decode image",
      operationId: "scan-8",
      attempts: 2,
      firstFailedAt: at,
      lastFailedAt: at,
      resolvedAt: null,
    },
  ],
  total: 1,
  openCount: 1,
  groups: [{ code: "DecodeError", count: 1 }],
};
const clients: QueryClient[] = [];
function mount(retryEnabled = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ProcessingFailures feature="thumbnails" retryEnabled={retryEnabled} />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  read.mockReset().mockResolvedValue(response);
  retry.mockReset().mockResolvedValue({ started: true, operationId: "retry" });
  success.mockReset();
  error.mockReset();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

it("shows durable counts, causes and metadata, then retries one file or all failures", async () => {
  mount();
  await screen.findByText("1 unresolved file");
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  await screen.findByText("photos/broken.png");
  expect(screen.getByText("Cannot decode image")).toBeTruthy();
  fireEvent.click(screen.getByText("Details", { exact: true }));
  expect(screen.getByText("Operation: scan-8")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry file" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith("thumbnails", { id: 8 }));
  await waitFor(() => expect(success).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith("thumbnails", {}));
  fireEvent.click(screen.getByRole("button", { name: "DecodeError · 1" }));
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith("thumbnails", { status: "open", code: "DecodeError" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "All causes" }));
});

it("pages tied timestamps and switches to resolved history without losing the cause", async () => {
  read.mockImplementation(async (_feature, query) =>
    query.before
      ? {
          ...response,
          entries: [{ ...response.entries[0], id: 7, path: "older.png" }],
        }
      : query.status === "resolved"
        ? {
            ...response,
            entries: [{ ...response.entries[0], attempts: 1, resolvedAt: at }],
          }
        : { ...response, nextCursor: 8, openCount: 2 },
  );
  mount();
  await screen.findByText("2 unresolved files");
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  await screen.findByText("photos/broken.png");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("photos/older.png");
  fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry file" })).toBeNull());
  expect(await screen.findByText(/^Resolved:/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Unresolved" }));
  await screen.findAllByRole("button", { name: "Retry file" });
});

it("keeps details available while processing is disabled", async () => {
  mount(false);
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  await screen.findByText("photos/broken.png");
  expect(screen.getByRole("button", { name: "Retry file" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Retry failed" }).hasAttribute("disabled")).toBe(true);
});

it("shows empty history and disables retry", async () => {
  read.mockResolvedValue({ entries: [], total: 0, openCount: 0, groups: [] });
  mount();
  await screen.findByText("0 unresolved files");
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  await screen.findByText("No unresolved failures.");
  fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
  await screen.findByText("No resolved failures.");
});

it("reports unavailable history and retry failures", async () => {
  read.mockRejectedValue(new Error("Database unavailable"));
  mount();
  await screen.findByText("Failure history unavailable");
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("Database unavailable");
});

it("shows pending states and preserves the failure when retry is rejected", async () => {
  let finish: (value: ProcessingFailuresResponse) => void = () => {};
  read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mount();
  expect(screen.getByText("Loading failure history…")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  expect(screen.getByText("Loading…")).toBeTruthy();
  finish(response);
  await screen.findByText("photos/broken.png");
  let rejectRetry: (error: Error) => void = () => {};
  retry.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectRetry = reject;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry file" }));
  await screen.findByRole("button", { name: "Starting…" });
  rejectRetry(new Error("Processing is busy"));
  await waitFor(() => expect(error).toHaveBeenCalledWith("Processing is busy"));
  expect(screen.getByText("photos/broken.png")).toBeTruthy();
});
