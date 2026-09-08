// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileList } from "./file-list";

const mockScrollToIndex = vi.fn();

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

  it("renders standard FileIcon directly when showThumbnails is false", () => {
    const entries = [makeEntry("pic.png", { ext: ".png", mime: "image/png" })];
    const { container } = renderList({ entries, showThumbnails: false });

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".size-6")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
