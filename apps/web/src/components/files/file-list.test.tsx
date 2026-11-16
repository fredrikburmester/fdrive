// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileList } from "./file-list";

const mockScrollToIndex = vi.fn();

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }));

vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      const virtualizer = actual.useVirtualizer(options);
      return {
        ...virtualizer,
        scrollToIndex: (
          index: number,
          scrollOptions?: Parameters<typeof virtualizer.scrollToIndex>[1],
        ) => {
          mockScrollToIndex(index, scrollOptions);
          return virtualizer.scrollToIndex(index, scrollOptions);
        },
      };
    },
  };
});

function makeEntry(name: string, overrides: Partial<FsEntry> = {}): FsEntry {
  return {
    path: `/${name}`,
    name,
    kind: "file",
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
    ...overrides,
  };
}

const ENTRIES: FsEntry[] = Array.from({ length: 5 }, (_, index) => makeEntry(`file-${index}.txt`));

const noop = () => {};

function renderList(overrides: Partial<React.ComponentProps<typeof FileList>> = {}) {
  return render(
    <FileList
      entries={ENTRIES}
      selected={new Set()}
      focusedPath={null}
      onEntryClick={noop}
      onEntryDoubleClick={noop}
      onContextAction={noop}
      getDragPaths={() => []}
      onInternalDrop={noop}
      onToggleSelectAll={noop}
      onClearSelection={noop}
      {...overrides}
    />,
  );
}

describe("FileList", () => {
  let offsetHeight: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrollToIndex.mockClear();
    offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  });

  afterEach(() => {
    cleanup();
    offsetHeight.mockRestore();
    viewport.mobile = false;
  });

  it("selects nothing when a pointer drags across several rows", () => {
    const onEntryClick = vi.fn();
    const onClearSelection = vi.fn();
    const { container } = renderList({ onEntryClick, onClearSelection });

    const rows = container.querySelectorAll("[data-path]");
    expect(rows.length).toBeGreaterThan(1);
    const first = rows[0];
    const last = rows[rows.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) {
      return;
    }

    fireEvent.pointerDown(first, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(last, { clientX: 0, clientY: 200 });
    fireEvent.pointerUp(last, { clientX: 0, clientY: 200 });

    expect(onClearSelection).not.toHaveBeenCalled();
    for (const row of rows) {
      expect(row.getAttribute("data-selected")).toBe("false");
    }
  });

  it("clears the selection on a plain click on empty listing space", () => {
    const onClearSelection = vi.fn();
    const { container } = renderList({ onClearSelection });

    const listing = container.querySelector('[data-slot="file-list"]');
    expect(listing).not.toBeNull();
    if (listing === null) {
      return;
    }

    // Clicking the scroll container itself, not any row, is a click on
    // empty listing space (below or beside the rendered rows).
    fireEvent.click(listing);

    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("does not clear the selection for a click that lands on a row, even its own background", () => {
    const onClearSelection = vi.fn();
    const onEntryClick = vi.fn();
    const { container } = renderList({ onClearSelection, onEntryClick });

    const row = container.querySelector('[data-path="/file-0.txt"]');
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }

    fireEvent.click(row);

    expect(onClearSelection).not.toHaveBeenCalled();
    expect(onEntryClick).toHaveBeenCalledTimes(1);
  });

  it("does not clear the selection for a shift-click on a row, so it still extends the range", () => {
    const onClearSelection = vi.fn();
    const onEntryClick = vi.fn();
    const { container } = renderList({ onClearSelection, onEntryClick });

    const row = container.querySelector('[data-path="/file-2.txt"]');
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }

    fireEvent.click(row, { shiftKey: true });

    expect(onClearSelection).not.toHaveBeenCalled();
    expect(onEntryClick).toHaveBeenCalledTimes(1);
    const [entry, modifiers] = onEntryClick.mock.calls[0] as [FsEntry, { shift: boolean }];
    expect(entry.path).toBe("/file-2.txt");
    expect(modifiers.shift).toBe(true);
  });

  it("does not clear the selection for a click on the header's own select-all checkbox", () => {
    const onClearSelection = vi.fn();
    const onToggleSelectAll = vi.fn();
    const { getByLabelText } = renderList({ onClearSelection, onToggleSelectAll });

    fireEvent.click(getByLabelText("Select all"));

    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it("scrolls to requested entry index and calls onScrollConsumed", () => {
    const onScrollConsumed = vi.fn();

    renderList({
      scrollRequest: { path: "/file-3.txt", token: 1 },
      onScrollConsumed,
    });

    expect(mockScrollToIndex).toHaveBeenCalledWith(3, { align: "auto" });
    expect(onScrollConsumed).toHaveBeenCalledWith(1);
  });

  it("reveals the same file twice when a new token request is dispatched", () => {
    const onScrollConsumed = vi.fn();

    const { rerender } = renderList({
      scrollRequest: { path: "/file-3.txt", token: 1 },
      onScrollConsumed,
    });
    expect(mockScrollToIndex).toHaveBeenCalledTimes(1);
    expect(mockScrollToIndex).toHaveBeenCalledWith(3, { align: "auto" });
    expect(onScrollConsumed).toHaveBeenCalledWith(1);

    // After scroll consumed, parent clears request
    rerender(
      <FileList
        entries={ENTRIES}
        selected={new Set()}
        focusedPath={null}
        onEntryClick={noop}
        onEntryDoubleClick={noop}
        onContextAction={noop}
        getDragPaths={() => []}
        onInternalDrop={noop}
        onToggleSelectAll={noop}
        onClearSelection={noop}
        scrollRequest={null}
        onScrollConsumed={onScrollConsumed}
      />,
    );
    expect(mockScrollToIndex).toHaveBeenCalledTimes(1);

    // Revealing the SAME file again with a new token retriggers scrollToIndex
    rerender(
      <FileList
        entries={ENTRIES}
        selected={new Set()}
        focusedPath={null}
        onEntryClick={noop}
        onEntryDoubleClick={noop}
        onContextAction={noop}
        getDragPaths={() => []}
        onInternalDrop={noop}
        onToggleSelectAll={noop}
        onClearSelection={noop}
        scrollRequest={{ path: "/file-3.txt", token: 2 }}
        onScrollConsumed={onScrollConsumed}
      />,
    );
    expect(mockScrollToIndex).toHaveBeenCalledTimes(2);
    expect(mockScrollToIndex).toHaveBeenLastCalledWith(3, { align: "auto" });
    expect(onScrollConsumed).toHaveBeenCalledWith(2);
  });

  it("renders a 24px thumbnail img for image files when showThumbnails is true", () => {
    const entries = [makeEntry("pic.png", { ext: ".png", mime: "image/png" })];
    const { container } = renderList({ entries, showThumbnails: true });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.className).toContain("size-6");
    expect(img?.getAttribute("src")).toContain("pic.png");
  });

  it("falls back to FileIcon in a matching 24px container when an image thumbnail fails to load", () => {
    const entries = [makeEntry("broken.png", { ext: ".png", mime: "image/png" })];
    const { container } = renderList({ entries, showThumbnails: true });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    if (img !== null) {
      fireEvent.error(img);
    }

    expect(container.querySelector("img")).toBeNull();
    const iconContainer = container.querySelector(".size-6");
    expect(iconContainer).not.toBeNull();
    expect(iconContainer?.querySelector("svg")).not.toBeNull();
  });

  it("renders a matching 24px fallback container for non-image entries when showThumbnails is true", () => {
    const entries = [makeEntry("notes.txt", { ext: ".txt", mime: "text/plain" })];
    const { container } = renderList({ entries, showThumbnails: true });

    expect(container.querySelector("img")).toBeNull();
    const iconContainer = container.querySelector(".size-6");
    expect(iconContainer).not.toBeNull();
    expect(iconContainer?.querySelector("svg")).not.toBeNull();
  });

  it("says who shares each folder in Shared with me and what this login may do there", () => {
    const entries = [
      makeEntry("Trip", { path: "/Shared with me/Trip", kind: "dir" }),
      makeEntry("Notes", { path: "/Shared with me/Notes", kind: "dir" }),
    ];
    const received = [
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        owner: "alice",
        name: "Trip",
        path: "/Shared with me/Trip",
        access: "read" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const { getByText, queryByText } = renderList({ entries, received });

    expect(getByText("alice · Can view")).toBeTruthy();
    expect(queryByText(/Can edit/)).toBeNull();
  });

  it("shows a symbolic link as a quiet row that does nothing", async () => {
    const onEntryClick = vi.fn();
    const onEntryDoubleClick = vi.fn();
    const onContextAction = vi.fn();
    const entries = [
      makeEntry("bin", { kind: "symlink" }),
      makeEntry("photo.jpg", { ext: ".jpg", mime: "image/jpeg" }),
    ];
    const { container, getByText, queryAllByRole, findAllByRole } = renderList({
      entries,
      onEntryClick,
      onEntryDoubleClick,
      onContextAction,
      showThumbnails: true,
    });

    const row = container.querySelector('[data-path="/bin"]');
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.getAttribute("title")).toMatch(/symbolic link/i);
    expect(row?.querySelector('[draggable="true"], [role="checkbox"], img')).toBeNull();
    fireEvent.click(getByText("bin"));
    fireEvent.doubleClick(getByText("bin"));
    fireEvent.contextMenu(getByText("bin"));
    expect(onEntryClick).not.toHaveBeenCalled();
    expect(onEntryDoubleClick).not.toHaveBeenCalled();
    expect(queryAllByRole("menuitem")).toEqual([]);
    // The rest of the listing works as before.
    fireEvent.click(getByText("photo.jpg"));
    expect(onEntryClick).toHaveBeenCalledWith(entries[1], { shift: false, meta: false });
    fireEvent.contextMenu(getByText("photo.jpg"));
    expect((await findAllByRole("menuitem")).length).toBeGreaterThan(0);
  });

  it("renders standard FileIcon directly when showThumbnails is false", () => {
    const entries = [makeEntry("pic.png", { ext: ".png", mime: "image/png" })];
    const { container } = renderList({ entries, showThumbnails: false });

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".size-6")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
  describe("on a phone", () => {
    beforeEach(() => {
      viewport.mobile = true;
    });

    it("folds Size and Modified under each name and counts the items in the header", () => {
      const entries = [
        makeEntry("Photos", { kind: "dir" }),
        makeEntry("guests.xlsx", { size: 25_088, ext: ".xlsx" }),
      ];
      const { container, getByText, queryByText } = renderList({ entries });

      expect(getByText("2 items")).toBeTruthy();
      expect(queryByText("Size")).toBeNull();
      expect(queryByText("Modified")).toBeNull();

      const file = container.querySelector('[data-path="/guests.xlsx"]');
      expect(file?.textContent).toMatch(/^guests\.xlsx\d[\d.]* KB · \S/);
      const folder = container.querySelector('[data-path="/Photos"]');
      expect(folder?.textContent).not.toContain("--");
      expect(folder?.textContent).not.toContain("KB");
    });

    it("says 1 item, not 1 items", () => {
      const { getByText } = renderList({ entries: [makeEntry("only.txt")] });
      expect(getByText("1 item")).toBeTruthy();
    });

    it("gives rows two-line height and a 44px floor at compact density", () => {
      const { container, rerender } = renderList();
      const heights = () =>
        new Set(
          [...container.querySelectorAll<HTMLElement>("[data-path]")].map(
            (row) => row.style.height,
          ),
        );
      expect(heights()).toEqual(new Set(["56px"]));

      rerender(
        <FileList
          entries={ENTRIES}
          selected={new Set()}
          focusedPath={null}
          onEntryClick={noop}
          onEntryDoubleClick={noop}
          onContextAction={noop}
          getDragPaths={() => []}
          onInternalDrop={noop}
          onToggleSelectAll={noop}
          onClearSelection={noop}
          density="compact"
        />,
      );
      expect(heights()).toEqual(new Set(["44px"]));
    });

    it("marks folders with a trailing chevron, except in tree view where they already have one", () => {
      const entries = [makeEntry("Photos", { kind: "dir" }), makeEntry("notes.txt")];
      const chevrons = (container: HTMLElement, path: string) =>
        container.querySelectorAll(`[data-path="${path}"] svg.lucide-chevron-right`).length;

      const list = renderList({ entries });
      expect(chevrons(list.container, "/Photos")).toBe(1);
      expect(chevrons(list.container, "/notes.txt")).toBe(0);
      cleanup();

      const tree = renderList({ entries, treeDepths: new Map(), treeExpanded: new Set() });
      // Only the disclosure toggle on the left.
      expect(chevrons(tree.container, "/Photos")).toBe(1);
      expect(tree.getByRole("button", { name: "Expand Photos" })).toBeTruthy();
    });

    it("puts who shares a folder on its detail line", () => {
      const entries = [makeEntry("Trip", { path: "/Shared with me/Trip", kind: "dir" })];
      const received = [
        {
          id: "00000000-0000-4000-8000-0000000000b1",
          owner: "alice",
          name: "Trip",
          path: "/Shared with me/Trip",
          access: "read" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      const { getByText } = renderList({ entries, received });
      expect(getByText(/ · alice · Can view$/)).toBeTruthy();
    });

    it("shows a 32px thumbnail next to the two lines", () => {
      const entries = [makeEntry("pic.png", { ext: ".png", mime: "image/png" })];
      const { container } = renderList({ entries, showThumbnails: true });
      expect(container.querySelector("img")?.className).toContain("size-8");
    });

    it("keeps a symbolic link's name and date readable", () => {
      const entries = [makeEntry("bin", { kind: "symlink" })];
      const { container } = renderList({ entries });
      const row = container.querySelector('[data-path="/bin"]');
      expect(row?.getAttribute("aria-disabled")).toBe("true");
      expect(row?.textContent).toMatch(/^bin\S/);
      expect(row?.textContent).not.toContain("--");
    });
  });
});
