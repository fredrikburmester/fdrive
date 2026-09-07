// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRID_WIDTH_STORAGE_KEY } from "@/lib/files/grid-layout";
import { FileGrid } from "./file-grid";

/** A no-op `ResizeObserver`: jsdom does not implement the real thing, and
 * these tests only need the grid's construction of one not to throw. */
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

const ENTRIES: FsEntry[] = Array.from({ length: 8 }, (_, index) => makeEntry(`file-${index}.txt`));

const noop = () => {};

function renderGrid(overrides: Partial<React.ComponentProps<typeof FileGrid>> = {}) {
  return render(
    <FileGrid
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

/** The `columns` value baked into a rendered row's `grid-template-columns`,
 * or `null` when no row is rendered at all (the skeleton fallback). */
function renderedColumns(container: HTMLElement): number | null {
  const row = container.querySelector('[style*="grid-template-columns"]');
  const style = row?.getAttribute("style") ?? null;
  const match = style?.match(/repeat\((\d+),/);
  return match?.[1] === undefined ? null : Number(match[1]);
}

describe("FileGrid", () => {
  // jsdom never runs real layout, so `offsetHeight` is always 0; the
  // virtualizer treats that as "nothing fits" and renders no rows at all.
  // Stubbing it to a plausible viewport size lets a seeded-width render
  // actually produce a visible row to assert on.
  let offsetHeight: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    offsetHeight.mockRestore();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("renders more than one column on the first render when a container width is seeded", () => {
    window.localStorage.setItem(GRID_WIDTH_STORAGE_KEY, JSON.stringify(700));

    const { container } = renderGrid();

    expect(renderedColumns(container)).not.toBeNull();
    expect(renderedColumns(container) ?? 0).toBeGreaterThan(1);
  });

  it("renders the grid skeleton, not a one-column layout, on a cold start with no seeded width", () => {
    const { container } = renderGrid();

    expect(container.querySelector('[data-slot="listing-skeleton-grid"]')).not.toBeNull();
    expect(renderedColumns(container)).toBeNull();
  });

  it("ignores a non-positive seeded width and still falls back to the skeleton", () => {
    window.localStorage.setItem(GRID_WIDTH_STORAGE_KEY, JSON.stringify(-10));

    const { container } = renderGrid();

    expect(container.querySelector('[data-slot="listing-skeleton-grid"]')).not.toBeNull();
  });

  it("selects nothing when a pointer drags across several tiles", () => {
    window.localStorage.setItem(GRID_WIDTH_STORAGE_KEY, JSON.stringify(700));
    const onEntryClick = vi.fn();
    const onClearSelection = vi.fn();

    const { container } = renderGrid({ onEntryClick, onClearSelection });

    const tiles = container.querySelectorAll("[data-path]");
    expect(tiles.length).toBeGreaterThan(1);
    const first = tiles[0];
    const last = tiles[tiles.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) {
      return;
    }

    fireEvent.pointerDown(first, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(last, { clientX: 200, clientY: 200 });
    fireEvent.pointerUp(last, { clientX: 200, clientY: 200 });

    expect(onClearSelection).not.toHaveBeenCalled();
    for (const tile of tiles) {
      expect(tile.getAttribute("data-selected")).toBe("false");
    }
  });

  it("clears the selection on a plain click on empty listing space", () => {
    window.localStorage.setItem(GRID_WIDTH_STORAGE_KEY, JSON.stringify(700));
    const onClearSelection = vi.fn();

    const { container } = renderGrid({ onClearSelection });

    // The scroll container that wraps the virtualized tiles: clicking it
    // directly, not any tile, is a click on empty listing space.
    const scrollContainer = container.querySelector(".overflow-auto");
    expect(scrollContainer).not.toBeNull();
    if (scrollContainer === null) {
      return;
    }

    fireEvent.click(scrollContainer);

    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("does not clear the selection for a shift-click on a tile, so it still extends the range", () => {
    window.localStorage.setItem(GRID_WIDTH_STORAGE_KEY, JSON.stringify(700));
    const onClearSelection = vi.fn();
    const onEntryClick = vi.fn();

    const { container } = renderGrid({ onClearSelection, onEntryClick });

    const tile = container.querySelector('[data-path="/file-2.txt"]');
    expect(tile).not.toBeNull();
    if (tile === null) {
      return;
    }

    fireEvent.click(tile, { shiftKey: true });

    expect(onClearSelection).not.toHaveBeenCalled();
    expect(onEntryClick).toHaveBeenCalledTimes(1);
    const [entry, modifiers] = onEntryClick.mock.calls[0] as [FsEntry, { shift: boolean }];
    expect(entry.path).toBe("/file-2.txt");
    expect(modifiers.shift).toBe(true);
  });

  it("renders an image thumbnail for an image file, using the thumb URL", () => {
    window.localStorage.setItem(GRID_WIDTH_STORAGE_KEY, JSON.stringify(700));
    const entries = [makeEntry("photo.png", { ext: ".png" })];

    const { container } = renderGrid({ entries });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain(encodeURIComponent("/photo.png"));
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("decoding")).toBe("async");
  });

  it("falls back to the file icon once an image thumbnail fails to load", () => {
    window.localStorage.setItem(GRID_WIDTH_STORAGE_KEY, JSON.stringify(700));
    const entries = [makeEntry("photo.png", { ext: ".png" })];

    const { container } = renderGrid({ entries });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    if (img === null) {
      return;
    }
    fireEvent.error(img);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("never renders an image thumbnail for a folder", () => {
    window.localStorage.setItem(GRID_WIDTH_STORAGE_KEY, JSON.stringify(700));
    const entries = [makeEntry("folder", { kind: "dir", ext: "" })];

    const { container } = renderGrid({ entries });

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
