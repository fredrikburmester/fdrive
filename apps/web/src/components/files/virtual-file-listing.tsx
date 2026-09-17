"use client";

import type { FsEntry, OfficeStatusResponse, ProviderCapabilities, Tag } from "@fdrive/contracts";
import { useEffect, useMemo, useReducer, useState } from "react";
import { useTreeChildren } from "@/lib/files/queries";
import { resolveRowClick } from "@/lib/files/row-click";
import {
  EMPTY_SELECTION,
  type SelectionAction,
  type SelectionState,
  selectionReducer,
} from "@/lib/files/selection";
import { DEFAULT_SORT_SPEC } from "@/lib/files/sorting";
import {
  EMPTY_TREE_STATE,
  readTreeState,
  type TreeState,
  toggle,
  writeTreeState,
} from "@/lib/files/tree";
import { flattenTree } from "@/lib/files/tree-rows";
import { useDefaultView } from "@/lib/files/use-default-view";
import { useListDensity } from "@/lib/files/use-list-density";
import { useRowClickAction } from "@/lib/files/use-row-click";
import { DEFAULT_CAPABILITIES } from "@/lib/identity/capabilities";
import type { RowContextAction } from "./file-context-menu";
import { FileGrid } from "./file-grid";
import { type ClickModifierKeys, FileList } from "./file-list";

const EMPTY_EXPANDED: ReadonlySet<string> = new Set();
const EMPTY_TAGS: readonly Tag[] = [];

export interface VirtualFileListingProps {
  readonly entries: readonly FsEntry[];
  readonly officeStatus?: OfficeStatusResponse | undefined;
  readonly tags?: readonly Tag[];
  readonly onOpen: (entry: FsEntry) => void;
  readonly onContextAction: (
    action: RowContextAction,
    entry: FsEntry,
    context: readonly FsEntry[],
  ) => void;
  readonly onToggleTag: (entries: readonly FsEntry[], tagId: string, checked: boolean) => void;
  readonly onToggleFavorite: (paths: readonly string[], next: boolean) => void;
  readonly hideMoveCopy?: boolean | undefined;
  readonly hideArchive?: boolean | undefined;
  readonly showReveal?: boolean | undefined;
  /** What the active login's storage can do, for every row's context menu. */
  readonly capabilities?: ProviderCapabilities | undefined;
}

/**
 * The common file renderer for listings that are not a single folder. It
 * follows the global default because a virtual listing has no folder path to
 * pin. Tree mode treats its entries as independent roots, then safely loads
 * children only after the user expands one of those real directories.
 */
export function VirtualFileListing({
  entries,
  officeStatus,
  tags = EMPTY_TAGS,
  onOpen,
  onContextAction,
  onToggleTag,
  onToggleFavorite,
  hideMoveCopy = false,
  hideArchive = false,
  showReveal = false,
  capabilities = DEFAULT_CAPABILITIES,
}: VirtualFileListingProps) {
  const [viewMode] = useDefaultView();
  const [rowClickAction] = useRowClickAction();
  const [density] = useListDensity();
  const [treeState, setTreeState] = useState<TreeState>(EMPTY_TREE_STATE);

  useEffect(() => {
    setTreeState(readTreeState(window.localStorage));
  }, []);

  const expanded = viewMode === "tree" ? treeState.expanded : EMPTY_EXPANDED;
  const childrenByPath = useTreeChildren(entries, expanded);
  const treeRows = useMemo(
    () =>
      viewMode === "tree"
        ? flattenTree(entries, treeState.expanded, childrenByPath, DEFAULT_SORT_SPEC)
        : [],
    [viewMode, entries, treeState.expanded, childrenByPath],
  );
  const displayTreeRows = useMemo(() => {
    const seen = new Set<string>();
    return treeRows.filter((row) => {
      if (seen.has(row.entry.path)) {
        return false;
      }
      seen.add(row.entry.path);
      return true;
    });
  }, [treeRows]);
  const displayEntries = useMemo(
    () => (viewMode === "tree" ? displayTreeRows.map((row) => row.entry) : entries),
    [viewMode, displayTreeRows, entries],
  );
  const treeDepths = useMemo(
    () => new Map(displayTreeRows.map((row) => [row.entry.path, row.depth])),
    [displayTreeRows],
  );
  const orderedPaths = useMemo(() => displayEntries.map((entry) => entry.path), [displayEntries]);
  const [selection, dispatchSelection] = useReducer(
    (state: SelectionState, action: SelectionAction) =>
      selectionReducer(state, action, orderedPaths),
    EMPTY_SELECTION,
  );

  useEffect(() => {
    dispatchSelection({ type: "reconcile", paths: orderedPaths });
  }, [orderedPaths]);

  function contextFor(entry: FsEntry): readonly FsEntry[] {
    return selection.selected.has(entry.path)
      ? displayEntries.filter((candidate) => selection.selected.has(candidate.path))
      : [entry];
  }

  function handleContextAction(action: RowContextAction, entry: FsEntry) {
    onContextAction(action, entry, contextFor(entry));
  }

  function handleEntryClick(entry: FsEntry, modifiers: ClickModifierKeys) {
    const intent = resolveRowClick(rowClickAction, modifiers);
    if (intent.kind === "open") {
      onOpen(entry);
      return;
    }
    if (intent.kind === "focus") {
      dispatchSelection({ type: "focus", path: entry.path });
      return;
    }
    dispatchSelection({ type: "click", path: entry.path, modifiers: intent.modifiers });
  }

  /** Double-click opens unless a plain click already does, so one open never fires three times. */
  function handleEntryDoubleClick(entry: FsEntry) {
    if (rowClickAction !== "open") {
      onOpen(entry);
    }
  }

  function handleToggleTag(paths: readonly string[], tagId: string, checked: boolean) {
    const context = paths.flatMap((path) => {
      const entry = displayEntries.find((candidate) => candidate.path === path);
      return entry === undefined ? [] : [entry];
    });
    onToggleTag(context, tagId, checked);
  }

  function toggleTree(entry: FsEntry) {
    setTreeState((previous) => {
      const next = toggle(previous, entry.path);
      writeTreeState(window.localStorage, next);
      return next;
    });
  }

  const commonProps = {
    entries: displayEntries,
    selected: selection.selected,
    focusedPath: selection.focus,
    onEntryClick: handleEntryClick,
    onEntryDoubleClick: handleEntryDoubleClick,
    officeStatus,
    onContextAction: handleContextAction,
    getDragPaths: (entry: FsEntry) => [entry.path],
    onInternalDrop: () => {},
    onToggleSelectAll: () => dispatchSelection({ type: "toggleAll", visiblePaths: orderedPaths }),
    onClearSelection: () => dispatchSelection({ type: "clear" }),
    tags,
    onToggleTag: handleToggleTag,
    onToggleFavorite,
    hideMoveCopy,
    hideArchive,
    showReveal,
    capabilities,
  };

  if (viewMode === "grid") {
    return <FileGrid {...commonProps} />;
  }

  return (
    <FileList
      {...commonProps}
      density={density}
      {...(viewMode === "tree"
        ? {
            treeDepths,
            treeExpanded: treeState.expanded,
            onToggleTreeExpand: toggleTree,
          }
        : {})}
    />
  );
}
