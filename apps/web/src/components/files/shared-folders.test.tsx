// @vitest-environment jsdom
import type { FsEntry, ReceivedGrant } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_SELECTION } from "@/lib/identity/capabilities";
import { FileContextMenu, type RowContextAction } from "./file-context-menu";
import { FilesToolbarActions } from "./toolbar";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

function entry(path: string, kind: FsEntry["kind"] = "dir"): FsEntry {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    kind,
    size: 0,
    ext: kind === "dir" ? "" : ".zip",
    mime: null,
    modifiedAt: "2026-01-01T00:00:00Z",
  };
}

const TRIP: ReceivedGrant = {
  id: "00000000-0000-4000-8000-0000000000b1",
  owner: "alice",
  name: "Trip",
  path: "/Shared with me/Trip",
  access: "read",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const BUDGET: ReceivedGrant = {
  ...TRIP,
  id: "00000000-0000-4000-8000-0000000000b2",
  owner: "bob",
  name: "Budget",
  path: "/Shared with me/Budget",
  access: "write",
};

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
  target: FsEntry,
  options: {
    selection?: { files: number; folders: number };
    onAction?: (action: RowContextAction, entry: FsEntry) => void;
  } = {},
) {
  render(
    <FileContextMenu
      entry={target}
      trash
      received={[TRIP, BUDGET]}
      {...(options.selection === undefined ? {} : { selection: options.selection })}
      onAction={options.onAction ?? vi.fn()}
    >
      <span>Row</span>
    </FileContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("Row"));
  await screen.findByRole("menuitem", { name: "Open" });
}

function item(name: string) {
  return screen.queryByRole("menuitem", { name });
}

describe("Share with people", () => {
  it("is offered on the login's own folder and opens for that folder", async () => {
    const onAction = vi.fn();
    const photos = entry("/Photos");
    await openMenu(photos, { onAction });

    fireEvent.click(screen.getByRole("menuitem", { name: "Share with people" }));

    expect(onAction).toHaveBeenCalledWith("shareWithPeople", photos);
  });

  it("is not offered for a file, a multi-selection or all of the login's files", async () => {
    await openMenu(entry("/a.zip", "file"));
    expect(item("Share with people")).toBeNull();
    expect(item("Share")).toBeTruthy();
    cleanup();
    await openMenu(entry("/Photos"), { selection: { files: 0, folders: 2 } });
    expect(item("Share with people")).toBeNull();
    cleanup();
    await openMenu(entry("/"));
    expect(item("Share with people")).toBeNull();
  });
});

describe("folders shared with the login", () => {
  it("offers Leave on a shared folder and nothing only its owner may do", async () => {
    const onAction = vi.fn();
    const trip = entry(TRIP.path);
    await openMenu(trip, { onAction });

    for (const name of ["Share", "Share with people", "Rename", "Move to", "Duplicate"]) {
      expect(item(name)).toBeNull();
    }
    expect(item("Move to Trash")).toBeNull();
    expect(item("Copy to")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Leave" }));
    expect(onAction).toHaveBeenCalledWith("leave", trip);
  });

  it("locks Shared with me itself without offering to leave it", async () => {
    await openMenu(entry("/Shared with me"));

    expect(item("Leave")).toBeNull();
    expect(item("Rename")).toBeNull();
    expect(item("Move to Trash")).toBeNull();
  });

  it("keeps everything inside a folder shared to view read-only", async () => {
    await openMenu(entry("/Shared with me/Trip/photos.zip", "file"));

    for (const name of [
      "Rename",
      "Move to",
      "Duplicate",
      "Move to Trash",
      "Extract here",
      "Leave",
    ]) {
      expect(item(name)).toBeNull();
    }
    expect(item("Copy to")).toBeTruthy();
    expect(item("Extract to")).toBeTruthy();
    expect(item("Download")).toBeTruthy();
  });

  it("allows changes inside a folder shared to edit, but never a public link", async () => {
    await openMenu(entry("/Shared with me/Budget/q1.zip", "file"));

    expect(item("Rename")).toBeTruthy();
    expect(item("Move to Trash")).toBeTruthy();
    expect(item("Extract here")).toBeTruthy();
    expect(item("Share")).toBeNull();
  });
});

describe("toolbar in a folder that takes nothing", () => {
  function renderToolbar(writeBlock: string | null) {
    render(
      <FilesToolbarActions
        viewMode="list"
        onViewModeChange={vi.fn()}
        sortSpec={{ key: "name", direction: "asc" }}
        onSortSpecChange={vi.fn()}
        density="comfortable"
        onDensityChange={vi.fn()}
        gridSize="medium"
        onGridSizeChange={vi.fn()}
        onNewFolder={vi.fn()}
        onNewFile={vi.fn()}
        onUploadFiles={vi.fn()}
        onUploadFolder={vi.fn()}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
        selection={{ ...NO_SELECTION, files: 1 }}
        onClearSelection={vi.fn()}
        onDuplicateSelection={vi.fn()}
        onCompressSelection={vi.fn()}
        onDownloadSelection={vi.fn()}
        showThumbnails={false}
        onShowThumbnailsChange={vi.fn()}
        writeBlock={writeBlock}
      />,
    );
  }

  it("turns New, Upload and Duplicate off and says why", () => {
    renderToolbar("alice shares this folder with you to view only.");

    // New and Upload both carry the reason in place of their own title.
    const blocked = screen.getAllByTitle("alice shares this folder with you to view only.");
    expect(blocked).toHaveLength(2);
    expect(blocked.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByTitle("New")).toBeNull();
    expect(screen.queryByTitle("Upload")).toBeNull();
    expect((screen.getByRole("button", { name: "Duplicate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("leaves them on in a folder that takes files", () => {
    renderToolbar(null);

    expect((screen.getByTitle("New") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTitle("Upload") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Duplicate" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
