// @vitest-environment jsdom
import type { ProcessingFailuresResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** The value a failed file's facts show beside a label. */
function fact(label: string): string | null | undefined {
  const list = screen.getByRole("list", { name: "Failed files" });
  return within(list).getByText(label).nextElementSibling?.textContent;
}

it("shows durable counts, causes and metadata, then retries one file or all failures", async () => {
  mount();
  // The count is red while anything is unresolved.
  expect((await screen.findByText("1 unresolved failure.")).className).toContain(
    "text-destructive",
  );
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  await screen.findByText("photos/broken.png");
  expect(screen.getByText("Cannot decode image")).toBeTruthy();
  // Every detail is on the row itself, with nothing to open first.
  expect(fact("Failed attempts")).toBe("2");
  expect(fact("First failure")).toBe(new Date(at).toLocaleString());
  expect(fact("Last failure")).toBe(new Date(at).toLocaleString());
  expect(fact("Operation")).toBe("scan-8");
  expect(screen.queryByText("Details", { exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry file" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith("thumbnails", { id: 8 }));
  await waitFor(() => expect(success).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith("thumbnails", {}));
  expect(screen.getByRole("button", { name: "All causes" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "DecodeError · 1" }));
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith("thumbnails", { status: "open", code: "DecodeError" }),
  );
  // The chosen cause says so, not only by its fill.
  const cause = await screen.findByRole("button", { name: "DecodeError · 1" });
  expect(cause.getAttribute("aria-pressed")).toBe("true");
  const all = screen.getByRole("button", { name: "All causes" });
  expect(all.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(all);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "All causes" }).getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
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
  await screen.findByText("2 unresolved failures.");
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  await screen.findByText("photos/broken.png");
  expect(screen.getByRole("button", { name: "Unresolved" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("photos/older.png");
  fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry file" })).toBeNull());
  // A resolved file also says when it was resolved.
  await waitFor(() => expect(fact("Resolved")).toBe(new Date(at).toLocaleString()));
  expect(screen.getByRole("button", { name: "Resolved" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Unresolved" }));
  await screen.findAllByRole("button", { name: "Retry file" });
  expect(
    within(screen.getByRole("list", { name: "Failed files" })).queryByText("Resolved"),
  ).toBeNull();
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
  // Nothing unresolved is plain ink, not red.
  expect((await screen.findByText("0 unresolved failures.")).className).not.toContain(
    "text-destructive",
  );
  fireEvent.click(screen.getByRole("button", { name: "View failures" }));
  await screen.findByText("No unresolved failures.");
  expect(screen.getByRole("button", { name: "Retry failed" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
  await screen.findByText("No resolved failures.");
});

it("reports unavailable history and retry failures", async () => {
  read.mockRejectedValue(new Error("Database unavailable"));
  mount();
  await screen.findByText("Failure history unavailable.");
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
