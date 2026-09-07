// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileList } from "./file-list";

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
      onChangeSelection={noop}
      onClearSelection={noop}
      {...overrides}
    />,
  );
}

describe("FileList", () => {
  // jsdom never runs real layout, so `offsetHeight` is always 0; the
  // virtualizer treats that as "nothing fits" and renders no rows at all.
  // Stubbing it to a plausible viewport size lets rows actually render.
  let offsetHeight: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  });

  afterEach(() => {
    cleanup();
    offsetHeight.mockRestore();
  });

  it("selects nothing when a pointer drags across several rows", () => {
    const onChangeSelection = vi.fn();
    const onClearSelection = vi.fn();
    const { container } = renderList({ onChangeSelection, onClearSelection });

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

    expect(onChangeSelection).not.toHaveBeenCalled();
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
});
