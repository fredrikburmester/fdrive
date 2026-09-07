// @vitest-environment jsdom
import type { ArchiveEntriesResponse, FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchivePreview } from "./archive-preview";

const mocks = vi.hoisted(() => ({
  useArchiveEntries: vi.fn(),
  extract: vi.fn(),
  compress: vi.fn(),
  seed: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  destinationPickerOnConfirm: vi.fn<(destination: string) => void>(),
}));

vi.mock("@/lib/archive/queries", () => ({
  useArchiveEntries: mocks.useArchiveEntries,
}));

vi.mock("@/lib/preview/deps", () => ({
  apiClient: {
    extract: (...args: unknown[]) => mocks.extract(...args),
    compress: (...args: unknown[]) => mocks.compress(...args),
  },
}));

vi.mock("@/lib/jobs/store", () => ({
  useJobsStore: { getState: () => ({ seed: mocks.seed }) },
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

vi.mock("@/components/files/destination-picker", () => ({
  DestinationPicker: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: (destination: string) => void;
  }) =>
    open ? (
      <button type="button" onClick={() => onConfirm("/chosen")}>
        confirm-destination
      </button>
    ) : null,
}));

afterEach(cleanup);

const ENTRY: FsEntry = {
  name: "docs.zip",
  path: "/docs.zip",
  kind: "file",
  ext: ".zip",
  mime: null,
  size: 2048,
  modifiedAt: "2026-09-07T00:00:00.000Z",
};

const RESPONSE: ArchiveEntriesResponse = {
  format: "zip",
  entries: [
    { path: "a.txt", kind: "file", size: 10, modifiedAt: "2026-01-01T00:00:00.000Z" },
    { path: "dir", kind: "dir", size: 0, modifiedAt: null },
    { path: "dir/nested.txt", kind: "file", size: 20, modifiedAt: null },
  ],
  truncated: false,
};

beforeEach(() => {
  for (const mock of [
    mocks.useArchiveEntries,
    mocks.extract,
    mocks.compress,
    mocks.seed,
    mocks.toastSuccess,
    mocks.toastError,
  ]) {
    mock.mockReset();
  }
  mocks.extract.mockResolvedValue({ jobId: "job-1" });
});

it("shows a loading skeleton while the query is pending", () => {
  mocks.useArchiveEntries.mockReturnValue({ status: "pending" });
  const { container } = render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);
  expect(container.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0);
});

it("shows a friendly error state when the archive cannot be read", () => {
  mocks.useArchiveEntries.mockReturnValue({ status: "error" });
  render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);
  expect(screen.getByText("This archive cannot be read.")).toBeTruthy();
});

it("renders entries grouped by folder, with a header for the totals", () => {
  mocks.useArchiveEntries.mockReturnValue({ status: "success", data: RESPONSE });
  render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);

  expect(screen.getByText("docs.zip")).toBeTruthy();
  expect(screen.getByText(/3 entries/)).toBeTruthy();
  expect(screen.getByText("a.txt")).toBeTruthy();
  expect(screen.getByText("dir/nested.txt")).toBeTruthy();
  // The folder group header for "dir" appears once even though it also has
  // an entry named exactly "dir" (a directory entry at the archive root).
  expect(screen.getAllByText("dir").length).toBeGreaterThanOrEqual(1);
});

it("filters entries by the search box", () => {
  mocks.useArchiveEntries.mockReturnValue({ status: "success", data: RESPONSE });
  render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);

  fireEvent.change(screen.getByPlaceholderText("Filter entries"), {
    target: { value: "nested" },
  });

  expect(screen.queryByText("a.txt")).toBeNull();
  expect(screen.getByText("dir/nested.txt")).toBeTruthy();
});

it("shows a no-match message when the search filters out every entry", () => {
  mocks.useArchiveEntries.mockReturnValue({ status: "success", data: RESPONSE });
  render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);

  fireEvent.change(screen.getByPlaceholderText("Filter entries"), {
    target: { value: "nothing matches this" },
  });

  expect(screen.getByText("No entries match your search.")).toBeTruthy();
});

it("shows the truncation note when the API reports it", () => {
  mocks.useArchiveEntries.mockReturnValue({
    status: "success",
    data: { ...RESPONSE, truncated: true },
  });
  render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);

  expect(screen.getByText(/this archive has more/)).toBeTruthy();
});

it("submits an extract-here job for the archive's own path", async () => {
  mocks.useArchiveEntries.mockReturnValue({ status: "success", data: RESPONSE });
  render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);

  fireEvent.click(screen.getByRole("button", { name: /Extract here/ }));

  await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledWith({ path: "/docs.zip" }));
  expect(mocks.seed).toHaveBeenCalled();
});

it("opens the destination picker and submits extract-to with the resolved destination", async () => {
  mocks.useArchiveEntries.mockReturnValue({ status: "success", data: RESPONSE });
  render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);

  fireEvent.click(screen.getByRole("button", { name: /Extract to/ }));
  fireEvent.click(screen.getByText("confirm-destination"));

  await vi.waitFor(() =>
    expect(mocks.extract).toHaveBeenCalledWith({
      path: "/docs.zip",
      destination: "/chosen/docs",
    }),
  );
});

it("renders a working download link", () => {
  mocks.useArchiveEntries.mockReturnValue({ status: "success", data: RESPONSE });
  render(<ArchivePreview entry={ENTRY} downloadUrl="/download" />);

  const downloadLink = screen.getByRole("button", { name: /Download/ });
  expect(downloadLink.getAttribute("href")).toBe("/download");
});
