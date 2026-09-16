// @vitest-environment jsdom
import type { FsEntry, OfficeStatusResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileContextMenu } from "./file-context-menu";
import { FilesToolbarActions, type FilesToolbarActionsProps } from "./toolbar";

// `FilesToolbarActions` now calls `useIsMobile`, which reads
// `window.matchMedia`; jsdom does not implement it.
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

const entry: FsEntry = {
  path: "/a.docx",
  name: "a.docx",
  kind: "file",
  size: 1,
  ext: ".docx",
  mime: null,
  modifiedAt: "2026-01-01T00:00:00.000Z",
};
const status: OfficeStatusResponse = {
  available: true,
  product: "onlyoffice",
  extensions: { view: ["docx"], edit: ["docx"], convert: ["docx"] },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("dispatches explicit office actions for a single file", async () => {
  for (const [label, mode] of [
    ["View in Office", "view"],
    ["Edit in Office", "edit"],
    ["Convert and edit", "convert"],
  ] as const) {
    const action = vi.fn();
    render(
      <FileContextMenu entry={entry} officeStatus={status} onAction={action}>
        <span>File</span>
      </FileContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("File"));
    fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    expect(action).toHaveBeenCalledWith(`office:${mode}`, entry);
    cleanup();
  }
});
it("hides office items when unavailable or acting on multiple files", async () => {
  for (const [available, selectionCount] of [
    [false, 1],
    [true, 2],
  ] as const) {
    render(
      <FileContextMenu
        entry={entry}
        officeStatus={{ ...status, available }}
        selection={{ files: selectionCount, folders: 0 }}
        onAction={vi.fn()}
      >
        <span>File</span>
      </FileContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("File"));
    await screen.findByRole("menuitem", { name: "Open" });
    expect(screen.queryByRole("menuitem", { name: "Edit in Office" })).toBeNull();
    cleanup();
  }
});
it("adds Document, Spreadsheet and Presentation only when office creation is available", async () => {
  const create = vi.fn();
  const props: FilesToolbarActionsProps = {
    viewMode: "list",
    onViewModeChange: vi.fn(),
    density: "comfortable",
    onDensityChange: vi.fn(),
    sortSpec: { key: "name", direction: "asc" },
    onSortSpecChange: vi.fn(),
    onNewFolder: vi.fn(),
    onNewFile: vi.fn(),
    onUploadFiles: vi.fn(),
    onUploadFolder: vi.fn(),
    detailsOpen: false,
    onToggleDetails: vi.fn(),
    selection: { files: 0, folders: 0 },
    onClearSelection: vi.fn(),
    onDuplicateSelection: vi.fn(),
    onCompressSelection: vi.fn(),
    onDownloadSelection: vi.fn(),
    showThumbnails: false,
    onShowThumbnailsChange: vi.fn(),
  };
  render(<FilesToolbarActions {...props} />);
  fireEvent.click(screen.getByTitle("New"));
  await screen.findByRole("menuitem", { name: "Text file" });
  expect(screen.queryByRole("menuitem", { name: "Document" })).toBeNull();
  cleanup();
  for (const kind of ["Document", "Spreadsheet", "Presentation"]) {
    render(<FilesToolbarActions {...props} onNewOfficeDocument={create} />);
    fireEvent.click(screen.getByTitle("New"));
    fireEvent.click(await screen.findByRole("menuitem", { name: kind }));
    expect(create).toHaveBeenLastCalledWith(kind.toLowerCase());
    cleanup();
  }
});

it("renders download action in toolbar selection pill and calls onDownloadSelection", () => {
  const onDownloadSelection = vi.fn();
  const props: FilesToolbarActionsProps = {
    viewMode: "list",
    onViewModeChange: vi.fn(),
    density: "comfortable",
    onDensityChange: vi.fn(),
    sortSpec: { key: "name", direction: "asc" },
    onSortSpecChange: vi.fn(),
    onNewFolder: vi.fn(),
    onNewFile: vi.fn(),
    onUploadFiles: vi.fn(),
    onUploadFolder: vi.fn(),
    detailsOpen: false,
    onToggleDetails: vi.fn(),
    selection: { files: 2, folders: 0 },
    onClearSelection: vi.fn(),
    onDuplicateSelection: vi.fn(),
    onCompressSelection: vi.fn(),
    onDownloadSelection,
    showThumbnails: false,
    onShowThumbnailsChange: vi.fn(),
  };
  render(<FilesToolbarActions {...props} />);
  const downloadButton = screen.getByLabelText("Download");
  fireEvent.click(downloadButton);
  expect(onDownloadSelection).toHaveBeenCalledTimes(1);
});

it("renders Show thumbnails option in View menu and toggles it", async () => {
  const onShowThumbnailsChange = vi.fn();
  const props: FilesToolbarActionsProps = {
    viewMode: "list",
    onViewModeChange: vi.fn(),
    density: "comfortable",
    onDensityChange: vi.fn(),
    sortSpec: { key: "name", direction: "asc" },
    onSortSpecChange: vi.fn(),
    onNewFolder: vi.fn(),
    onNewFile: vi.fn(),
    onUploadFiles: vi.fn(),
    onUploadFolder: vi.fn(),
    detailsOpen: false,
    onToggleDetails: vi.fn(),
    selection: { files: 0, folders: 0 },
    onClearSelection: vi.fn(),
    onDuplicateSelection: vi.fn(),
    onCompressSelection: vi.fn(),
    onDownloadSelection: vi.fn(),
    showThumbnails: false,
    onShowThumbnailsChange,
  };
  render(<FilesToolbarActions {...props} />);
  fireEvent.click(screen.getByTitle("View"));
  const item = await screen.findByRole("menuitemcheckbox", { name: /Show thumbnails/ });
  fireEvent.click(item);
  expect(onShowThumbnailsChange).toHaveBeenCalledWith(true);
});
