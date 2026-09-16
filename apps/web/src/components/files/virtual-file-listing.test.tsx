// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VirtualFileListing } from "./virtual-file-listing";

const fixtures = vi.hoisted(() => ({
  view: "list" as "list" | "grid" | "tree",
  fileList: vi.fn(),
  fileGrid: vi.fn(),
  children: new Map<string, readonly FsEntry[]>(),
}));

vi.mock("@/lib/files/use-default-view", () => ({
  useDefaultView: () => [fixtures.view, vi.fn()] as const,
}));
vi.mock("@/lib/files/queries", () => ({ useTreeChildren: () => fixtures.children }));
vi.mock("./file-list", () => ({
  FileList: (props: unknown) => {
    fixtures.fileList(props);
    return <div data-testid="file-list" />;
  },
}));
vi.mock("./file-grid", () => ({
  FileGrid: (props: unknown) => {
    fixtures.fileGrid(props);
    return <div data-testid="file-grid" />;
  },
}));

const entries: FsEntry[] = [
  {
    name: "folder",
    path: "/folder",
    kind: "dir",
    size: 0,
    ext: "",
    mime: "",
    modifiedAt: "2026-01-01T00:00:00Z",
  },
];

afterEach(() => {
  cleanup();
  fixtures.fileList.mockClear();
  fixtures.fileGrid.mockClear();
  fixtures.children.clear();
  window.localStorage.clear();
});

function renderListing(overrides: Partial<ComponentProps<typeof VirtualFileListing>> = {}) {
  return render(
    <VirtualFileListing
      entries={entries}
      onOpen={vi.fn()}
      onContextAction={vi.fn()}
      onToggleTag={vi.fn()}
      onToggleFavorite={vi.fn()}
      hideMoveCopy
      hideArchive
      showReveal
      {...overrides}
    />,
  );
}

it("uses the global list default and keeps virtual-list restrictions", () => {
  fixtures.view = "list";
  renderListing();
  expect(screen.getByTestId("file-list")).toBeDefined();
  expect(fixtures.fileList).toHaveBeenCalledWith(
    expect.objectContaining({ hideMoveCopy: true, hideArchive: true, showReveal: true }),
  );
});

it("uses the global grid default with the same virtual-list restrictions", () => {
  fixtures.view = "grid";
  renderListing();
  expect(screen.getByTestId("file-grid")).toBeDefined();
  expect(fixtures.fileGrid).toHaveBeenCalledWith(
    expect.objectContaining({ hideMoveCopy: true, hideArchive: true, showReveal: true }),
  );
});

it("renders flat virtual entries as expandable tree roots", () => {
  fixtures.view = "tree";
  renderListing();
  expect(screen.getByTestId("file-list")).toBeDefined();
  expect(fixtures.fileList).toHaveBeenCalledWith(
    expect.objectContaining({
      treeDepths: expect.any(Map),
      onToggleTreeExpand: expect.any(Function),
    }),
  );
});

it("uses expanded descendants' metadata when changing their tags", () => {
  const folder = entries[0];
  if (folder === undefined) throw new Error("missing folder fixture");
  const child: FsEntry = {
    ...folder,
    name: "child.txt",
    path: "/folder/child.txt",
    kind: "file",
    meta: { favorite: false, tagIds: ["existing"] },
  };
  fixtures.view = "tree";
  fixtures.children.set("/folder", [child]);
  window.localStorage.setItem("fdrive.tree", JSON.stringify(["/folder"]));
  const onToggleTag = vi.fn();
  renderListing({ onToggleTag });

  const props = fixtures.fileList.mock.calls.at(-1)?.[0] as {
    onToggleTag: (paths: readonly string[], tagId: string, checked: boolean) => void;
  };
  props.onToggleTag([child.path], "new", true);
  expect(onToggleTag).toHaveBeenCalledWith([child], "new", true);
});

it("deduplicates a tagged root entry repeated as an expanded child", () => {
  const folder = entries[0];
  if (folder === undefined) throw new Error("missing folder fixture");
  const child: FsEntry = {
    ...folder,
    name: "child.txt",
    path: "/folder/child.txt",
    kind: "file",
  };
  fixtures.view = "tree";
  fixtures.children.set("/folder", [child]);
  window.localStorage.setItem("fdrive.tree", JSON.stringify(["/folder"]));
  renderListing({ entries: [...entries, child] });

  const props = fixtures.fileList.mock.calls.at(-1)?.[0] as { entries: readonly FsEntry[] };
  expect(props.entries.map((entry) => entry.path)).toEqual(["/folder", "/folder/child.txt"]);
});

it("opens on a plain click and ignores double-click when row click is set to open", () => {
  fixtures.view = "list";
  window.localStorage.setItem("fdrive.list.rowClick", '"open"');
  const onOpen = vi.fn();
  renderListing({ onOpen });
  const props = fixtures.fileList.mock.calls.at(-1)?.[0] as {
    onEntryClick: (entry: FsEntry, modifiers: { shift: boolean; meta: boolean }) => void;
    onEntryDoubleClick: (entry: FsEntry) => void;
  };
  const entry = entries[0] as FsEntry;
  props.onEntryClick(entry, { shift: false, meta: false });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(entry);
  props.onEntryDoubleClick(entry);
  expect(onOpen).toHaveBeenCalledTimes(1);
  props.onEntryClick(entry, { shift: false, meta: true });
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("keeps double-click opening and click selecting by default", () => {
  fixtures.view = "list";
  const onOpen = vi.fn();
  renderListing({ onOpen });
  const props = fixtures.fileList.mock.calls.at(-1)?.[0] as {
    onEntryClick: (entry: FsEntry, modifiers: { shift: boolean; meta: boolean }) => void;
    onEntryDoubleClick: (entry: FsEntry) => void;
  };
  const entry = entries[0] as FsEntry;
  props.onEntryClick(entry, { shift: false, meta: false });
  expect(onOpen).not.toHaveBeenCalled();
  props.onEntryDoubleClick(entry);
  expect(onOpen).toHaveBeenCalledWith(entry);
});
