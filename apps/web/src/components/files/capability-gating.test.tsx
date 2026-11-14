// @vitest-environment jsdom
import type { FsEntry, OfficeStatusResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileContextMenu } from "./file-context-menu";
import { FilesToolbarActions, type FilesToolbarActionsProps } from "./toolbar";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const file: FsEntry = {
  name: "report.docx",
  path: "/report.docx",
  kind: "file",
  size: 10,
  ext: ".docx",
  mime: null,
  modifiedAt: "2026-01-01T00:00:00Z",
};
const folder: FsEntry = { ...file, name: "photos", path: "/photos", kind: "dir", ext: "" };
const office: OfficeStatusResponse = {
  available: true,
  extensions: { view: ["docx"], edit: ["docx"], convert: [] },
} as unknown as OfficeStatusResponse;

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openMenu(entry: FsEntry, trash = true) {
  render(
    <FileContextMenu entry={entry} officeStatus={office} trash={trash} onAction={vi.fn()}>
      <span>Row</span>
    </FileContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("Row"));
  await screen.findByRole("menuitem", { name: "Open" });
}

it("shows Share, the Office items and Download as zip", async () => {
  await openMenu(folder);
  expect(screen.getByRole("menuitem", { name: "Share" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Download as zip" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Move to Trash" })).toBeTruthy();
  cleanup();
  await openMenu(file);
  expect(screen.getByRole("menuitem", { name: "View in Office" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
});

it("reads Delete without trash", async () => {
  await openMenu(file, false);
  expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Move to Trash" })).toBeNull();
});

function toolbarProps(overrides: Partial<FilesToolbarActionsProps> = {}): FilesToolbarActionsProps {
  return {
    viewMode: "list",
    onViewModeChange: vi.fn(),
    density: "comfortable",
    onDensityChange: vi.fn(),
    gridSize: "medium",
    onGridSizeChange: vi.fn(),
    sortSpec: { key: "name", direction: "asc" },
    onSortSpecChange: vi.fn(),
    onNewFolder: vi.fn(),
    onNewFile: vi.fn(),
    onNewOfficeDocument: vi.fn(),
    onUploadFiles: vi.fn(),
    onUploadFolder: vi.fn(),
    detailsOpen: false,
    onToggleDetails: vi.fn(),
    selection: { files: 0, folders: 1 },
    onClearSelection: vi.fn(),
    onDuplicateSelection: vi.fn(),
    onCompressSelection: vi.fn(),
    onDownloadSelection: vi.fn(),
    showThumbnails: true,
    onShowThumbnailsChange: vi.fn(),
    ...overrides,
  };
}

it("toolbar downloads a selection of folders", () => {
  render(<FilesToolbarActions {...toolbarProps()} />);
  expect(screen.getByLabelText("Download")).toBeTruthy();
});

it("toolbar hides Show thumbnails when the files folder is not indexed", async () => {
  render(<FilesToolbarActions {...toolbarProps({ indexed: false })} />);
  fireEvent.click(screen.getByTitle("View"));
  await screen.findByRole("menuitemradio", { name: /List/ });
  expect(screen.queryByText("Show thumbnails")).toBeNull();
  cleanup();
  render(<FilesToolbarActions {...toolbarProps()} />);
  fireEvent.click(screen.getByTitle("View"));
  expect(await screen.findByText("Show thumbnails")).toBeTruthy();
});

it("toolbar offers icon size in grid view and density in list view", async () => {
  const onGridSizeChange = vi.fn();
  render(<FilesToolbarActions {...toolbarProps({ viewMode: "grid", onGridSizeChange })} />);
  fireEvent.click(screen.getByTitle("View"));
  expect(await screen.findByText("Icon size")).toBeTruthy();
  expect(screen.queryByText("Density")).toBeNull();
  expect(screen.getByRole("menuitemradio", { name: "Medium" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Large" }));
  expect(onGridSizeChange).toHaveBeenCalledWith("large");
  cleanup();

  render(<FilesToolbarActions {...toolbarProps({ viewMode: "list" })} />);
  fireEvent.click(screen.getByTitle("View"));
  expect(await screen.findByText("Density")).toBeTruthy();
  expect(screen.queryByText("Icon size")).toBeNull();
});

it("offers Organize in the menu and selection bar only when AI is set up", async () => {
  const onAction = vi.fn();
  render(
    <FileContextMenu entry={file} showOrganize onAction={onAction}>
      <span>Row</span>
    </FileContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("Row"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Organize" }));
  expect(onAction).toHaveBeenCalledWith("organize", file);
  cleanup();

  await openMenu(file);
  expect(screen.queryByRole("menuitem", { name: "Organize" })).toBeNull();
  cleanup();

  const onOrganizeSelection = vi.fn();
  render(<FilesToolbarActions {...toolbarProps({ onOrganizeSelection })} />);
  fireEvent.click(screen.getByLabelText("Organize"));
  expect(onOrganizeSelection).toHaveBeenCalled();
  cleanup();
  render(<FilesToolbarActions {...toolbarProps()} />);
  expect(screen.queryByLabelText("Organize")).toBeNull();
});
