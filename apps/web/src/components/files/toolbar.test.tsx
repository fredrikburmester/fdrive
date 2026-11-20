// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesBreadcrumb, FilesToolbarActions, type FilesToolbarActionsProps } from "./toolbar";

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }));

afterEach(() => {
  cleanup();
  viewport.mobile = true;
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
    ...overrides,
  };
}

describe("FilesBreadcrumb on a phone", () => {
  it("shows Home as plain text at the root, with nothing above it to open", () => {
    render(<FilesBreadcrumb path="/" />);
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(nav).getByText("Home")).toBeTruthy();
    expect(within(nav).queryByRole("button")).toBeNull();
  });

  it("shows only the current folder, which opens its whole name and the folders above it", async () => {
    render(<FilesBreadcrumb path="/Familj/Fester/Bröllop 2027 – planering" />);
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(nav).queryByText("Familj")).toBeNull();
    expect(within(nav).queryByText("Home")).toBeNull();

    fireEvent.click(within(nav).getByRole("button", { name: /Bröllop 2027 – planering/ }));

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Fester", "Familj", "Home"]);
    expect(items[0]?.getAttribute("href")).toBe("/files/Familj/Fester");
    expect(items[2]?.getAttribute("href")).toBe("/files");
    // The whole name, which the bar may cut short, heads the menu.
    expect(screen.getAllByText("Bröllop 2027 – planering")).toHaveLength(2);
  });
});

describe("FilesToolbarActions on a phone", () => {
  it("puts Upload at the top of the New menu", async () => {
    const onUploadFiles = vi.fn();
    render(<FilesToolbarActions {...toolbarProps({ onUploadFiles })} />);

    fireEvent.click(screen.getByTitle("New"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.slice(0, 3).map((item) => item.textContent)).toEqual([
      "Upload files",
      "Upload folder",
      "New folder⌘⇧N",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload files" }));
    expect(onUploadFiles).toHaveBeenCalledTimes(1);
  });

  it("leaves Upload out of More, now that New holds it", async () => {
    render(<FilesToolbarActions {...toolbarProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "View" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Upload" })).toBeNull();
  });

  it("keeps New and Upload as separate menus on desktop", async () => {
    viewport.mobile = false;
    render(<FilesToolbarActions {...toolbarProps()} />);
    expect(screen.getByTitle("Upload")).toBeTruthy();

    fireEvent.click(screen.getByTitle("New"));
    await screen.findByRole("menuitem", { name: /New folder/ });
    expect(screen.queryByRole("menuitem", { name: "Upload files" })).toBeNull();
  });
});

describe("FilesToolbarActions chat slot", () => {
  it("puts the chat button just before the details toggle on desktop", () => {
    viewport.mobile = false;
    render(
      <FilesToolbarActions {...toolbarProps({ chatSlot: <button type="button">Chat</button> })} />,
    );

    const chat = screen.getByRole("button", { name: "Chat" });
    const details = screen.getByRole("button", { name: "Toggle details" });
    expect(chat.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const upload = screen.getByTitle("Upload");
    expect(upload.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts it just before More on a phone", () => {
    viewport.mobile = true;
    render(
      <FilesToolbarActions {...toolbarProps({ chatSlot: <button type="button">Chat</button> })} />,
    );

    const chat = screen.getByRole("button", { name: "Chat" });
    const more = screen.getByRole("button", { name: "More" });
    expect(chat.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows nothing extra without one", () => {
    viewport.mobile = false;
    render(<FilesToolbarActions {...toolbarProps()} />);
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  });
});
