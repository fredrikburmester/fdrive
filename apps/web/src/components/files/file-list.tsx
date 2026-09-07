"use client";

import type { FsEntry, OfficeStatusResponse, Tag } from "@fdrive/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRightIcon } from "lucide-react";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { TagDots } from "@/components/metadata/tag-dots";
import { Checkbox } from "@/components/ui/checkbox";
import { endDragSession, getActiveDragPaths, startDragSession } from "@/lib/dnd";
import { isBackgroundClick } from "@/lib/files/background-click";
import { INTERNAL_DND_TYPE, readDraggedPaths, writeDraggedPaths } from "@/lib/files/deps";
import { dropTargetState, effectFor } from "@/lib/files/dnd-targets";
import { contextEntries, contextSelectionCount } from "@/lib/files/selection";
import { formatBytes, formatDate } from "@/lib/format";
import { tagCheckState as computeTagCheckState } from "@/lib/metadata/tag-set";
import { cn } from "@/lib/utils";
import { createDragImageElement } from "./drag-image";
import { FileContextMenu, type RowContextAction } from "./file-context-menu";
import { FileIcon } from "./file-icon";

export const FILE_ROW_HEIGHT = 36;

/** Indent, in pixels, added per tree depth level in tree view. */
export const TREE_INDENT_PX = 20;

export interface ClickModifierKeys {
  shift: boolean;
  meta: boolean;
}

export interface FileListProps {
  officeStatus?: OfficeStatusResponse | undefined;
  entries: readonly FsEntry[];
  selected: ReadonlySet<string>;
  focusedPath: string | null;
  onEntryClick: (entry: FsEntry, modifiers: ClickModifierKeys) => void;
  onEntryDoubleClick: (entry: FsEntry) => void;
  onContextAction: (action: RowContextAction, entry: FsEntry) => void;
  getDragPaths: (entry: FsEntry) => string[];
  onInternalDrop: (paths: string[], targetPath: string, effect: "move" | "copy") => void;
  /** Toggles between selecting every visible row and none, from the header checkbox. */
  onToggleSelectAll: () => void;
  /**
   * Replaces the current selection outright. Not called by `FileList`
   * itself (there is no more drag-to-select), but part of the shared
   * listing prop contract other callers (see `FileGrid`) still rely on.
   */
  onChangeSelection: (paths: string[]) => void;
  /** Clears the selection, for a plain click on empty listing space. */
  onClearSelection: () => void;
  /**
   * Present only in tree view: each row's indent depth, keyed by path. Rows
   * missing from the map (or when this prop is absent entirely) render
   * without a disclosure chevron, at depth 0, as in the plain list view.
   */
  treeDepths?: ReadonlyMap<string, number>;
  /** Which folder paths are expanded, for the chevron's rotation, in tree view. */
  treeExpanded?: ReadonlySet<string>;
  /** Called when a folder row's disclosure chevron is toggled, in tree view. */
  onToggleTreeExpand?: (entry: FsEntry) => void;
  /** Every tag known to the account, for each row's tag dots and the "Tags"
   * context menu submenu. Defaults to none. */
  tags?: readonly Tag[];
  /** Adds or removes `tagId` on every entry in the group a row's context
   * menu action would apply to (see `contextEntries`). Defaults to a no-op. */
  onToggleTag?: (paths: readonly string[], tagId: string, checked: boolean) => void;
  /** Opens the full tag editor for the group of entries a row's context
   * menu action would apply to. Defaults to a no-op. */
  onOpenTagsEditor?: (entries: readonly FsEntry[]) => void;
  /** Favorites (or unfavorites) every entry in the group a row's context
   * menu action would apply to. Defaults to a no-op. */
  onToggleFavorite?: (paths: readonly string[], next: boolean) => void;
  /** Hides "Move to" and "Copy to" in every row's context menu, for a
   * read-only "virtual listing". Defaults to `false`. */
  hideMoveCopy?: boolean;
  /** Shows "Reveal in folder" in every row's context menu, for a "virtual
   * listing" whose rows are not already inside their own folder. Defaults
   * to `false`. */
  showReveal?: boolean;
  /** Hides "Compress" and "Extract" in every row's context menu, for
   * a "virtual listing" that does not run the archive jobs. Defaults to
   * `false`. */
  hideArchive?: boolean;
  /** Whether the active identity's storage provider exposes a trash, for
   * every row's context menu (see `FileContextMenu`). Defaults to `false`. */
  trashAvailable?: boolean;
}

const EMPTY_TAGS: readonly Tag[] = [];
const NO_OP_TOGGLE_TAG = () => {};
const NO_OP_OPEN_TAGS_EDITOR = () => {};
const NO_OP_TOGGLE_FAVORITE = () => {};

function entryFavorite(entry: FsEntry): boolean {
  return entry.meta?.favorite === true;
}

function groupFavorite(entries: readonly FsEntry[]): boolean {
  return entries.length > 0 && entries.every(entryFavorite);
}

function modifiersFrom(event: ReactMouseEvent): ClickModifierKeys {
  return { shift: event.shiftKey, meta: event.metaKey || event.ctrlKey };
}

/** A virtualized, sortable-columns list view of a folder's entries. */
export function FileList({
  entries,
  officeStatus,
  selected,
  focusedPath,
  onEntryClick,
  onEntryDoubleClick,
  onContextAction,
  getDragPaths,
  onInternalDrop,
  onToggleSelectAll,
  onClearSelection,
  treeDepths,
  treeExpanded,
  onToggleTreeExpand,
  tags = EMPTY_TAGS,
  onToggleTag = NO_OP_TOGGLE_TAG,
  onOpenTagsEditor = NO_OP_OPEN_TAGS_EDITOR,
  onToggleFavorite = NO_OP_TOGGLE_FAVORITE,
  hideMoveCopy = false,
  showReveal = false,
  hideArchive = false,
  trashAvailable = false,
}: FileListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const selectedCount = entries.filter((entry) => selected.has(entry.path)).length;
  const allSelected = entries.length > 0 && selectedCount === entries.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 10,
  });

  const onClearSelectionRef = useRef(onClearSelection);
  onClearSelectionRef.current = onClearSelection;

  useEffect(() => {
    const container = parentRef.current;
    if (container === null) {
      return;
    }
    // A native listener, not a JSX `onClick` prop: a portaled overlay (a
    // context menu, a dialog) is a React-tree descendant of this listing
    // even though it renders outside the container in the real DOM, and
    // React's synthetic events still bubble through the React tree across
    // that portal boundary. A JSX `onClick` here would misfire and clear
    // the selection for a click on that unrelated, portaled content; a
    // native listener only ever fires for events whose real DOM target is
    // actually inside the container.
    function handleClick(event: MouseEvent) {
      if (isBackgroundClick(event.target as Element | null)) {
        onClearSelectionRef.current();
      }
    }
    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, []);

  function handleDragStart(event: DragEvent<HTMLDivElement>, entry: FsEntry) {
    const paths = getDragPaths(entry);
    writeDraggedPaths(event.dataTransfer, paths);
    event.dataTransfer.effectAllowed = "copyMove";
    startDragSession(paths);
    const dragImage = createDragImageElement(document, entry.name, paths.length);
    event.dataTransfer.setDragImage(dragImage, 12, 12);
    window.setTimeout(() => dragImage.remove(), 0);
  }

  function handleDragEnd() {
    endDragSession();
    setDropTarget(null);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, entry: FsEntry) {
    if (entry.kind !== "dir" || !event.dataTransfer.types.includes(INTERNAL_DND_TYPE)) {
      return;
    }
    const draggedPaths = getActiveDragPaths() ?? [];
    if (dropTargetState(draggedPaths, entry.path) !== "valid") {
      event.dataTransfer.dropEffect = "none";
      if (dropTarget === entry.path) {
        setDropTarget(null);
      }
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = effectFor(event);
    setDropTarget(entry.path);
  }

  function handleDragLeave(entry: FsEntry) {
    if (dropTarget === entry.path) {
      setDropTarget(null);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, entry: FsEntry) {
    if (entry.kind !== "dir") {
      return;
    }
    const paths = readDraggedPaths(event.dataTransfer);
    setDropTarget(null);
    if (paths !== null && paths.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      onInternalDrop(paths, entry.path, effectFor(event));
    }
  }

  return (
    <div ref={parentRef} className="relative h-full overflow-auto" data-slot="file-list">
      {/**
       * `data-selection-exclude`: this header lives inside the same scroll
       * container the background-click listener listens on (so it stays
       * `sticky` to it), but its own controls are not listing content; see
       * `isBackgroundClick`.
       */}
      <div
        data-selection-exclude
        className="sticky top-0 z-10 flex h-9 items-center gap-3 border-border border-b bg-background/95 px-3 text-muted-foreground text-xs backdrop-blur supports-backdrop-filter:bg-background/75"
      >
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onCheckedChange={onToggleSelectAll}
          aria-label={allSelected ? "Deselect all" : "Select all"}
        />
        <span className="flex-1">Name</span>
        <span className="w-20 text-right">Size</span>
        <span className="w-28">Modified</span>
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index];
          if (entry === undefined) {
            return null;
          }
          const isSelected = selected.has(entry.path);
          const isFocused = focusedPath === entry.path;
          const isTreeRow = treeDepths !== undefined;
          const depth = treeDepths?.get(entry.path) ?? 0;
          const isExpandedFolder = entry.kind === "dir" && (treeExpanded?.has(entry.path) ?? false);
          const group = contextEntries(entry, entries, selected);
          const groupPaths = group.map((candidate) => candidate.path);

          return (
            <FileContextMenu
              officeStatus={officeStatus}
              key={entry.path}
              entry={entry}
              onAction={onContextAction}
              selectionCount={contextSelectionCount(entry.path, selected)}
              includesFolder={group.some((candidate) => candidate.kind === "dir")}
              hideMoveCopy={hideMoveCopy}
              showReveal={showReveal}
              hideArchive={hideArchive}
              tags={tags}
              tagCheckState={(tagId) =>
                computeTagCheckState(
                  group.map((candidate) => ({ tagIds: candidate.meta?.tagIds ?? [] })),
                  tagId,
                )
              }
              onToggleTag={(tagId, checked) => onToggleTag(groupPaths, tagId, checked)}
              onOpenTagsEditor={() => onOpenTagsEditor(group)}
              favorite={groupFavorite(group)}
              onToggleFavorite={(next) => onToggleFavorite(groupPaths, next)}
              trashAvailable={trashAvailable}
            >
              {/** biome-ignore lint/a11y/noStaticElementInteractions: this row supports drag-and-drop and click selection; keyboard activation is handled by the listing container's roving onKeyDown */}
              {/** biome-ignore lint/a11y/useKeyWithClickEvents: same as above */}
              <div
                data-path={entry.path}
                data-selected={isSelected}
                data-drop-target={dropTarget === entry.path}
                onDragOver={(event) => handleDragOver(event, entry)}
                onDragLeave={() => handleDragLeave(entry)}
                onDrop={(event) => handleDrop(event, entry)}
                onClick={(event) => onEntryClick(entry, modifiersFrom(event))}
                onDoubleClick={() => onEntryDoubleClick(entry)}
                className="absolute inset-x-0 flex items-center gap-3 border-border/60 border-b px-3 text-sm hover:bg-muted/60 data-[drop-target=true]:bg-primary/5 data-[drop-target=true]:ring-2 data-[drop-target=true]:ring-inset data-[drop-target=true]:ring-primary/50 data-[focused=true]:ring-1 data-[focused=true]:ring-inset data-[focused=true]:ring-ring data-[selected=true]:bg-primary/10"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingLeft: 12 + depth * TREE_INDENT_PX,
                  paddingRight: 12,
                }}
                data-focused={isFocused}
              >
                {isTreeRow &&
                  (entry.kind === "dir" ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleTreeExpand?.(entry);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                      aria-label={
                        isExpandedFolder ? `Collapse ${entry.name}` : `Expand ${entry.name}`
                      }
                      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRightIcon
                        className={cn(
                          "size-3.5 transition-transform",
                          isExpandedFolder && "rotate-90",
                        )}
                      />
                    </button>
                  ) : (
                    <span className="size-4 shrink-0" />
                  ))}
                {/**
                 * Only this inner wrapper (the checkbox through the date
                 * column) is `draggable`, not the row itself: the row's own
                 * padding and this wrapper's leading gap stay plain, un-
                 * draggable background, so the browser never mistakes a
                 * plain click there for the start of a native HTML5 drag.
                 */}
                {/** biome-ignore lint/a11y/noStaticElementInteractions: this is the row's drag handle; click/selection semantics live on the row above it */}
                <div
                  draggable
                  onDragStart={(event) => handleDragStart(event, entry)}
                  onDragEnd={handleDragEnd}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <Checkbox
                    checked={isSelected}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onCheckedChange={() => onEntryClick(entry, { shift: false, meta: true })}
                    aria-label={`Select ${entry.name}`}
                  />
                  <FileIcon kind={entry.kind} ext={entry.ext} mime={entry.mime} />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <TagDots tags={tags} tagIds={entry.meta?.tagIds ?? []} />
                  <span className="w-20 shrink-0 text-right text-muted-foreground text-xs">
                    {entry.kind === "dir" ? "--" : formatBytes(entry.size)}
                  </span>
                  <span className="w-28 shrink-0 text-muted-foreground text-xs">
                    {formatDate(new Date(entry.modifiedAt))}
                  </span>
                </div>
              </div>
            </FileContextMenu>
          );
        })}
      </div>
    </div>
  );
}
