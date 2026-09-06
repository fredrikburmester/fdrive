// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, render } from "@testing-library/react";
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

function makeEntry(name: string): FsEntry {
  return {
    path: `/${name}`,
    name,
    kind: "file",
    size: 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    ext: "",
    mime: null,
  };
}

const ENTRIES: FsEntry[] = Array.from({ length: 8 }, (_, index) => makeEntry(`file-${index}.txt`));

const noop = () => {};

function renderGrid() {
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
      onChangeSelection={noop}
      onClearSelection={noop}
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
});
