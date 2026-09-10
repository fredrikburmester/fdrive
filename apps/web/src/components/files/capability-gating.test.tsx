// @vitest-environment jsdom
import type { FsEntry, OfficeStatusResponse } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";
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

const everything = allCapabilities(true);

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

async function openMenu(
  entry: FsEntry,
  capabilities = everything,
  selection?: { files: number; folders: number },
) {
  render(
    <FileContextMenu
      entry={entry}
      officeStatus={office}
      capabilities={capabilities}
      {...(selection === undefined ? {} : { selection })}
      onAction={vi.fn()}
    >
      <span>Row</span>
    </FileContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("Row"));
  await screen.findByRole("menuitem", { name: "Open" });
}

it("shows Share, the Office items and Download as zip when the login can do everything", async () => {
  await openMenu(folder);
  expect(screen.getByRole("menuitem", { name: "Share" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Download as zip" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Move to Trash" })).toBeTruthy();
  cleanup();
  await openMenu(file);
  expect(screen.getByRole("menuitem", { name: "View in office" })).toBeTruthy();
});

it("hides Share without shares", async () => {
  await openMenu(file, { ...everything, shares: false });
  expect(screen.queryByRole("menuitem", { name: "Share" })).toBeNull();
});

it("hides the Office items without office even when Office itself is available", async () => {
  await openMenu(file, { ...everything, office: false });
  expect(screen.queryByRole("menuitem", { name: "View in office" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Edit in office" })).toBeNull();
});

it("hides Download for a folder without zip but keeps a single file's download", async () => {
  await openMenu(folder, { ...everything, zip: false });
  expect(screen.queryByRole("menuitem", { name: /Download/ })).toBeNull();
  cleanup();
  await openMenu(file, { ...everything, zip: false });
  expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
});

it("reads Download, not Download as zip, for a mixed selection without zip", async () => {
  await openMenu(file, { ...everything, zip: false }, { files: 2, folders: 1 });
  expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
});

it("reads Delete without trash", async () => {
  await openMenu(file, { ...everything, trash: false });
  expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Move to Trash" })).toBeNull();
});

function toolbarProps(overrides: Partial<FilesToolbarActionsProps> = {}): FilesToolbarActionsProps {
  return {
    viewMode: "list",
    onViewModeChange: vi.fn(),
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

it("toolbar hides Download for a folder-only selection without zip", () => {
  render(<FilesToolbarActions {...toolbarProps({ capabilities: everything })} />);
  expect(screen.getByLabelText("Download")).toBeTruthy();
  cleanup();
  render(
    <FilesToolbarActions {...toolbarProps({ capabilities: { ...everything, zip: false } })} />,
  );
  expect(screen.queryByLabelText("Download")).toBeNull();
  cleanup();
  render(
    <FilesToolbarActions
      {...toolbarProps({
        capabilities: { ...everything, zip: false },
        selection: { files: 2, folders: 0 },
      })}
    />,
  );
  expect(screen.getByLabelText("Download")).toBeTruthy();
});

it("toolbar hides the Office document kinds without office", async () => {
  render(
    <FilesToolbarActions {...toolbarProps({ capabilities: { ...everything, office: false } })} />,
  );
  fireEvent.click(screen.getByTitle("New"));
  await screen.findByRole("menuitem", { name: "Text file" });
  expect(screen.queryByRole("menuitem", { name: "Document" })).toBeNull();
});

it("toolbar hides Show thumbnails without index", async () => {
  render(
    <FilesToolbarActions {...toolbarProps({ capabilities: { ...everything, index: false } })} />,
  );
  fireEvent.click(screen.getByTitle("View"));
  await screen.findByRole("menuitemradio", { name: /List/ });
  expect(screen.queryByText("Show thumbnails")).toBeNull();
  cleanup();
  render(<FilesToolbarActions {...toolbarProps({ capabilities: everything })} />);
  fireEvent.click(screen.getByTitle("View"));
  expect(await screen.findByText("Show thumbnails")).toBeTruthy();
});
