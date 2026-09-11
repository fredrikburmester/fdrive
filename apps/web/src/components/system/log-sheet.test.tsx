// @vitest-environment jsdom
import type { SystemLogEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useSystemLogsMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/lib/api/system-logs-queries", () => ({
  useSystemLogs: (...args: unknown[]) => useSystemLogsMock(...args),
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const { LogSheet } = await import("./log-sheet");

const ENTRIES: SystemLogEntry[] = [
  {
    id: "api:2",
    at: "2026-09-09T10:20:30.000Z",
    level: "error",
    message: "Reindex failed: unreachable",
    data: { root: "sftpgo" },
    source: "api",
  },
  {
    id: "scan:1",
    at: "2026-09-09T10:00:00.000Z",
    level: "info",
    message: "Scan of sftpgo finished",
    source: "indexer",
  },
];

/** Runs the macrotask the deferred object-URL release is scheduled in. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function loaded(entries: SystemLogEntry[], extra: Record<string, unknown> = {}) {
  return {
    data: { pages: [{ subsystem: "indexer", entries }], pageParams: [undefined] },
    isPending: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    error: null,
    ...extra,
  };
}

describe("LogSheet", () => {
  beforeEach(() => {
    useSystemLogsMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });
  afterEach(cleanup);

  it("only queries once opened, then lists entries newest first with their level", async () => {
    useSystemLogsMock.mockReturnValue(loaded(ENTRIES));
    render(<LogSheet subsystem="indexer" />);
    expect(useSystemLogsMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Logs" }));

    expect(await screen.findByText("Reindex failed: unreachable")).toBeTruthy();
    expect(useSystemLogsMock).toHaveBeenCalledWith("indexer", { level: "info", enabled: true });
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.textContent).toContain("error");
    expect(rows[1]?.textContent).toContain("Scan of sftpgo finished");
    expect(screen.getByText("2 entries")).toBeTruthy();
  });

  it("switches the minimum level through the toggle group", async () => {
    useSystemLogsMock.mockReturnValue(loaded(ENTRIES));
    render(<LogSheet subsystem="ocr" title="OCR log" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    await screen.findByText("OCR log");

    fireEvent.click(screen.getByRole("button", { name: "Errors" }));

    await waitFor(() =>
      expect(useSystemLogsMock).toHaveBeenLastCalledWith("ocr", { level: "error", enabled: true }),
    );
  });

  it("copies the formatted lines to the clipboard and reports it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useSystemLogsMock.mockReturnValue(loaded(ENTRIES));
    render(<LogSheet subsystem="indexer" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    await screen.findByText("Scan of sftpgo finished");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Copied 2 log lines"));
    expect(writeText.mock.calls[0]?.[0]).toContain(
      '2026-09-09T10:20:30.000Z  ERROR  Reindex failed: unreachable  {"root":"sftpgo"}',
    );
  });

  it("reports a clipboard failure instead of throwing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    useSystemLogsMock.mockReturnValue(loaded(ENTRIES));
    render(<LogSheet subsystem="indexer" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    await screen.findByText("Scan of sftpgo finished");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it("downloads a .txt and an .ndjson file through a temporary anchor", async () => {
    let urls = 0;
    const createObjectURL = vi.fn(() => {
      urls += 1;
      return `blob:log-${urls}`;
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    /** What the anchor and its object URL looked like at the moment of the click. */
    const clicked: { href: string; name: string; attached: boolean; revoked: unknown[] }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({
        href: this.href,
        name: this.download,
        attached: document.body.contains(this),
        revoked: revokeObjectURL.mock.calls.flat(),
      });
    });
    useSystemLogsMock.mockReturnValue(loaded(ENTRIES));
    render(<LogSheet subsystem="thumbnails" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    await screen.findByText("Scan of sftpgo finished");

    fireEvent.click(screen.getByRole("button", { name: "Download .txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Download .ndjson" }));

    const today = new Date().toISOString().slice(0, 10);
    expect(click).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(clicked.map((entry) => entry.name)).toEqual([
      `fdrive-thumbnails-logs-${today}.txt`,
      `fdrive-thumbnails-logs-${today}.ndjson`,
    ]);
    expect(clicked.map((entry) => entry.href)).toEqual(["blob:log-1", "blob:log-2"]);
    // The anchor is in the document while it is clicked, and gone after.
    expect(clicked.map((entry) => entry.attached)).toEqual([true, true]);
    expect(document.body.querySelector("a[download]")).toBeNull();
    // Its object URL outlives the click: revoking in the same task can
    // leave the browser with nothing to save.
    expect(clicked.map((entry) => entry.revoked)).toEqual([[], []]);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await nextTask();

    expect(revokeObjectURL.mock.calls).toEqual([["blob:log-1"], ["blob:log-2"]]);
    click.mockRestore();
  });

  it("shows the empty, loading and error states and loads older pages", async () => {
    useSystemLogsMock.mockReturnValue(loaded([]));
    const { unmount } = render(<LogSheet subsystem="search" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(await screen.findByText("No entries at this level yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();

    useSystemLogsMock.mockReturnValue(loaded([], { isPending: true, data: undefined }));
    const pending = render(<LogSheet subsystem="search" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(await screen.findByText("Loading…")).toBeTruthy();
    pending.unmount();

    useSystemLogsMock.mockReturnValue(
      loaded([], { isError: true, error: new Error("boom"), data: undefined }),
    );
    const failed = render(<LogSheet subsystem="search" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(await screen.findByText(/Could not load the log: boom/)).toBeTruthy();
    failed.unmount();

    const fetchNextPage = vi.fn();
    useSystemLogsMock.mockReturnValue(loaded(ENTRIES, { hasNextPage: true, fetchNextPage }));
    render(<LogSheet subsystem="search" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it("expands attached data on click", async () => {
    useSystemLogsMock.mockReturnValue(loaded(ENTRIES));
    render(<LogSheet subsystem="indexer" />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    fireEvent.click(await screen.findByText("Reindex failed: unreachable"));
    expect(await screen.findByText(/"root": "sftpgo"/)).toBeTruthy();
  });
});
