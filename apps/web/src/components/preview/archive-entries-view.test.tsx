// @vitest-environment jsdom
import type { ArchiveEntriesResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ArchiveEntriesSkeleton, ArchiveEntriesView } from "./archive-entries-view";

afterEach(cleanup);

const RESPONSE: ArchiveEntriesResponse = {
  format: "tar.gz",
  entries: [
    { path: "a.txt", kind: "file", size: 10, modifiedAt: "2026-01-01T00:00:00.000Z" },
    { path: "dir", kind: "dir", size: 0, modifiedAt: null },
    { path: "dir/nested.txt", kind: "file", size: 20, modifiedAt: null },
  ],
  truncated: false,
};

it("shows the skeleton placeholder rows", () => {
  const { container } = render(<ArchiveEntriesSkeleton />);
  expect(container.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0);
});

it("renders the header, format label, and grouped entries", () => {
  render(<ArchiveEntriesView name="docs.tar.gz" size={2048} data={RESPONSE} />);

  expect(screen.getByText("docs.tar.gz")).toBeTruthy();
  expect(screen.getByText(/gzip-compressed TAR archive/)).toBeTruthy();
  expect(screen.getByText(/3 entries/)).toBeTruthy();
  expect(screen.getByText("a.txt")).toBeTruthy();
  expect(screen.getByText("dir/nested.txt")).toBeTruthy();
});

it("renders no links on entries; the table is purely presentational", () => {
  render(<ArchiveEntriesView name="docs.zip" size={2048} data={RESPONSE} />);
  expect(screen.queryAllByRole("link").length).toBe(0);
});

it("filters entries by the search box", () => {
  render(<ArchiveEntriesView name="docs.zip" size={2048} data={RESPONSE} />);

  fireEvent.change(screen.getByPlaceholderText("Filter entries"), {
    target: { value: "nested" },
  });

  expect(screen.queryByText("a.txt")).toBeNull();
  expect(screen.getByText("dir/nested.txt")).toBeTruthy();
});

it("shows a no-match message when the search filters out every entry", () => {
  render(<ArchiveEntriesView name="docs.zip" size={2048} data={RESPONSE} />);

  fireEvent.change(screen.getByPlaceholderText("Filter entries"), {
    target: { value: "nothing matches this" },
  });

  expect(screen.getByText("No entries match your search.")).toBeTruthy();
});

it("shows an empty-archive message when there are no entries at all", () => {
  render(<ArchiveEntriesView name="empty.zip" size={0} data={{ ...RESPONSE, entries: [] }} />);
  expect(screen.getByText("This archive is empty.")).toBeTruthy();
});

it("shows the truncation note when the API reports it", () => {
  render(
    <ArchiveEntriesView name="docs.zip" size={2048} data={{ ...RESPONSE, truncated: true }} />,
  );
  expect(screen.getByText(/this archive has more/)).toBeTruthy();
});

it("renders the actions slot when provided, and omits it otherwise", () => {
  const { rerender } = render(
    <ArchiveEntriesView
      name="docs.zip"
      size={2048}
      data={RESPONSE}
      actions={<button type="button">custom-action</button>}
    />,
  );
  expect(screen.getByText("custom-action")).toBeTruthy();

  rerender(<ArchiveEntriesView name="docs.zip" size={2048} data={RESPONSE} />);
  expect(screen.queryByText("custom-action")).toBeNull();
});

it("falls back to the raw format string for an unrecognized format label", () => {
  render(
    <ArchiveEntriesView
      name="docs.rar"
      size={2048}
      data={{ ...RESPONSE, format: "rar" as ArchiveEntriesResponse["format"] }}
    />,
  );
  expect(screen.getByText((text) => text.includes("· rar ·"))).toBeTruthy();
});
