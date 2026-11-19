// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileList } from "./file-list";

const mockScrollToIndex = vi.fn();

const viewport = vi.hoisted(() => ({ mobile: false, touch: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }));
vi.mock("@/hooks/use-coarse-pointer", () => ({ useCoarsePointer: () => viewport.touch }));

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
    viewport.touch = false;
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
    const { getByLabelText, getByRole } = renderList({ onClearSelection, onToggleSelectAll });

    fireEvent.click(getByRole("button", { name: "Select" }));
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

  it("keeps the colored kind icon in the 24px column when showThumbnails is false", () => {
    const entries = [makeEntry("pic.png", { ext: ".png", mime: "image/png" })];
    const { container } = renderList({ entries, showThumbnails: false });

    expect(container.querySelector("img")).toBeNull();
    const icon = container.querySelector('.size-6 svg[data-icon-kind="image"]');
    expect(icon?.getAttribute("class")).toContain("text-tag-purple");
  });

  describe("in tree view", () => {
    const folder = makeEntry("Photos", { kind: "dir" });
    const file = makeEntry("notes.txt", { ext: ".txt" });

    it("turns a folder's icon into a chevron that toggles it without selecting the row", () => {
      const onToggleTreeExpand = vi.fn();
      const onEntryClick = vi.fn();
      const { getByRole, queryByRole, rerender } = renderList({
        entries: [folder, file],
        treeDepths: new Map(),
        treeExpanded: new Set(),
        onToggleTreeExpand,
        onEntryClick,
      });

      const chevron = getByRole("button", { name: "Expand Photos" });
      expect(chevron.getAttribute("aria-expanded")).toBe("false");
      // It shares the icon's 24px column instead of adding a column of its own.
      expect(chevron.parentElement?.querySelector('svg[data-icon-kind="folder"]')).not.toBeNull();
      expect(queryByRole("button", { name: "Expand notes.txt" })).toBeNull();

      fireEvent.click(chevron);
      expect(onToggleTreeExpand).toHaveBeenCalledWith(folder);
      expect(onEntryClick).not.toHaveBeenCalled();

      rerender(
        <FileList
          entries={[folder, file]}
          selected={new Set()}
          focusedPath={null}
          onEntryClick={onEntryClick}
          onEntryDoubleClick={noop}
          onContextAction={noop}
          getDragPaths={() => []}
          onInternalDrop={noop}
          onToggleSelectAll={noop}
          onClearSelection={noop}
          treeDepths={new Map()}
          treeExpanded={new Set([folder.path])}
          onToggleTreeExpand={onToggleTreeExpand}
        />,
      );
      expect(getByRole("button", { name: "Collapse Photos" }).getAttribute("aria-expanded")).toBe(
        "true",
      );
    });

    it("joins each child to its folders with one guide line per level", () => {
      const entries = [
        makeEntry("a", { kind: "dir" }),
        makeEntry("b", { path: "/a/b", kind: "dir" }),
        makeEntry("c.txt", { path: "/a/b/c.txt" }),
      ];
      const { container } = renderList({
        entries,
        treeDepths: new Map([
          ["/a", 0],
          ["/a/b", 1],
          ["/a/b/c.txt", 2],
        ]),
        treeExpanded: new Set(["/a", "/a/b"]),
      });
      const guides = (path: string) =>
        container.querySelectorAll(`[data-path="${path}"] [data-slot="tree-guide"]`).length;

      expect([guides("/a"), guides("/a/b"), guides("/a/b/c.txt")]).toEqual([0, 1, 2]);
    });

    it("on a touch screen, gives the chevron a column of its own and keeps More visible", () => {
      viewport.touch = true;
      const { getByRole, container } = renderList({
        entries: [folder, file],
        treeDepths: new Map(),
        treeExpanded: new Set(),
      });

      const chevron = getByRole("button", { name: "Expand Photos" });
      expect(chevron.parentElement?.getAttribute("data-path")).toBe("/Photos");
      expect(getByRole("button", { name: "More actions for Photos" }).className).not.toContain(
        "opacity-0",
      );
      expect(container.querySelector('[data-slot="tree-guide"]')).toBeNull();
    });
  });

  it("opens a row's menu from its More button, without selecting the row", async () => {
    const onEntryClick = vi.fn();
    const onContextAction = vi.fn();
    const entry = ENTRIES[1];
    if (entry === undefined) throw new Error("missing entry fixture");
    const { getByRole, findByRole } = renderList({ onEntryClick, onContextAction });

    const more = getByRole("button", { name: `More actions for ${entry.name}` });
    expect(more.className).toContain("opacity-0");
    fireEvent.click(more);
    fireEvent.click(await findByRole("menuitem", { name: "Rename" }));

    expect(onContextAction).toHaveBeenCalledWith("rename", entry);
    expect(onEntryClick).not.toHaveBeenCalled();
  });

  it("shows the checkbox column only while Select is on, and leaves row clicks alone", () => {
    const onEntryClick = vi.fn();
    const onEntryDoubleClick = vi.fn();
    const [first, second] = ENTRIES;
    if (first === undefined || second === undefined) throw new Error("missing entry fixtures");
    const { getByRole, getByText, queryByRole, queryAllByRole } = renderList({
      onEntryClick,
      onEntryDoubleClick,
    });
    expect(queryAllByRole("checkbox")).toEqual([]);

    const toggle = getByRole("button", { name: "Select" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(getByRole("button", { name: "Done" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("checkbox", { name: "Select all" })).toBeTruthy();

    // A checkbox adds its row to the selection.
    fireEvent.click(getByRole("checkbox", { name: `Select ${second.name}` }));
    expect(onEntryClick).toHaveBeenLastCalledWith(second, { shift: false, meta: true });

    // The row itself still clicks and opens as it does without Select.
    fireEvent.click(getByText(first.name));
    expect(onEntryClick).toHaveBeenLastCalledWith(first, { shift: false, meta: false });
    fireEvent.doubleClick(getByText(first.name));
    expect(onEntryDoubleClick).toHaveBeenCalledWith(first);

    fireEvent.click(getByRole("button", { name: "Done" }));
    expect(queryByRole("checkbox", { name: "Select all" })).toBeNull();
    expect(queryAllByRole("checkbox")).toEqual([]);
  });

  it("rounds a run of selected rows only at its outer corners", () => {
    const paths = ENTRIES.map((entry) => entry.path);
    const selected = new Set([0, 1, 2, 4].map((index) => paths[index] ?? ""));
    const { container } = renderList({ selected });
    const corners = (index: number) => {
      const row = container.querySelector(`[data-path="${paths[index]}"]`);
      return ["rounded-t-none", "rounded-b-none"].filter((name) => row?.classList.contains(name));
    };

    expect(corners(0)).toEqual(["rounded-b-none"]);
    expect(corners(1)).toEqual(["rounded-t-none", "rounded-b-none"]);
    expect(corners(2)).toEqual(["rounded-t-none"]);
    expect(corners(3)).toEqual([]);
    expect(corners(4)).toEqual([]);
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
