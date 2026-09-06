"use client";

import type { FsEntry } from "@fdrive/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { endDragSession, getActiveDragPaths, startDragSession } from "@/lib/dnd";
import { INTERNAL_DND_TYPE, readDraggedPaths, writeDraggedPaths } from "@/lib/files/deps";
import { dropTargetState, effectFor } from "@/lib/files/dnd-targets";
import { buildGridLayout } from "@/lib/files/marquee";
import { contextEntries, contextSelectionCount } from "@/lib/files/selection";
import { cn } from "@/lib/utils";
import { createDragImageElement } from "./drag-image";
import { FileContextMenu, type RowContextAction } from "./file-context-menu";
import { FileIcon } from "./file-icon";
import type { ClickModifierKeys } from "./file-list";
import { useMarqueeSelection } from "./use-marquee-selection";

/** A grid tile's fixed footprint, in pixels: used to compute how many
 * columns fit and, in `ListingSkeleton`, to size its placeholder tiles. */
export const GRID_TILE_WIDTH = 112;
export const GRID_TILE_HEIGHT = 104;
const TILE_WIDTH = GRID_TILE_WIDTH;
const TILE_HEIGHT = GRID_TILE_HEIGHT;

export interface FileGridProps {
  entries: readonly FsEntry[];
  selected: ReadonlySet<string>;
  focusedPath: string | null;
  onEntryClick: (entry: FsEntry, modifiers: ClickModifierKeys) => void;
  onEntryDoubleClick: (entry: FsEntry) => void;
  onContextAction: (action: RowContextAction, entry: FsEntry) => void;
  getDragPaths: (entry: FsEntry) => string[];
  onInternalDrop: (paths: string[], targetPath: string, effect: "move" | "copy") => void;
  /** Toggles between selecting every visible tile and none, from the header checkbox. */
  onToggleSelectAll: () => void;
  /** Replaces the current selection outright, for a marquee drag. */
  onChangeSelection: (paths: string[]) => void;
  /** Clears the selection, for a plain click on empty listing space. */
  onClearSelection: () => void;
}

function modifiersFrom(event: ReactMouseEvent): ClickModifierKeys {
  return { shift: event.shiftKey, meta: event.metaKey || event.ctrlKey };
}

/** A virtualized grid of tiles, one row of tiles per virtualized "row". */
export function FileGrid({
  entries,
  selected,
  focusedPath,
  onEntryClick,
  onEntryDoubleClick,
  onContextAction,
  getDragPaths,
  onInternalDrop,
  onToggleSelectAll,
  onChangeSelection,
  onClearSelection,
}: FileGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const selectedCount = entries.filter((entry) => selected.has(entry.path)).length;
  const allSelected = entries.length > 0 && selectedCount === entries.length;
  const someSelected = selectedCount > 0 && !allSelected;

  useEffect(() => {
    const el = parentRef.current;
    if (el === null) {
      return;
    }
    const observer = new ResizeObserver((observedEntries) => {
      const entry = observedEntries[0];
      if (entry !== undefined) {
        setColumns(Math.max(1, Math.floor(entry.contentRect.width / TILE_WIDTH)));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(entries.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => TILE_HEIGHT,
    overscan: 4,
  });

  const marquee = useMarqueeSelection({
    containerRef: parentRef,
    getSelected: () => [...selected],
    onChangeSelection,
    onClearSelection,
    getLayout: () =>
      buildGridLayout(
        entries.map((entry) => entry.path),
        virtualizer.getVirtualItems().map((item) => ({
          index: item.index,
          start: item.start,
          size: item.size,
        })),
        columns,
        TILE_WIDTH,
        TILE_HEIGHT,
      ),
  });

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
    <div className="flex h-full flex-col" data-slot="file-grid">
      <div className="flex h-9 shrink-0 items-center gap-2 border-border border-b bg-background/95 px-3 text-muted-foreground text-xs backdrop-blur supports-backdrop-filter:bg-background/75">
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onCheckedChange={onToggleSelectAll}
          aria-label={allSelected ? "Deselect all" : "Select all"}
        />
        <span>{selectedCount > 0 ? `${selectedCount} selected` : "Select all"}</span>
      </div>
      <div ref={parentRef} className="relative min-h-0 flex-1 overflow-auto p-2">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const start = virtualRow.index * columns;
            const rowEntries = entries.slice(start, start + columns);

            return (
              <div
                key={virtualRow.key}
                className="absolute inset-x-0 grid gap-1"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
              >
                {rowEntries.map((entry) => {
                  const isSelected = selected.has(entry.path);
                  const isFocused = focusedPath === entry.path;

                  return (
                    <FileContextMenu
                      key={entry.path}
                      entry={entry}
                      onAction={onContextAction}
                      selectionCount={contextSelectionCount(entry.path, selected)}
                      includesFolder={contextEntries(entry, entries, selected).some(
                        (candidate) => candidate.kind === "dir",
                      )}
                    >
                      {/** biome-ignore lint/a11y/noStaticElementInteractions: this tile supports drag-and-drop and click selection; keyboard activation is handled by the grid container's roving onKeyDown */}
                      {/** biome-ignore lint/a11y/useKeyWithClickEvents: same as above */}
                      <div
                        data-path={entry.path}
                        data-selected={isSelected}
                        data-focused={isFocused}
                        data-drop-target={dropTarget === entry.path}
                        draggable
                        onDragStart={(event) => handleDragStart(event, entry)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(event) => handleDragOver(event, entry)}
                        onDragLeave={() => handleDragLeave(entry)}
                        onDrop={(event) => handleDrop(event, entry)}
                        onClick={(event) => onEntryClick(entry, modifiersFrom(event))}
                        onDoubleClick={() => onEntryDoubleClick(entry)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-lg p-2 text-center outline-none hover:bg-muted/60",
                          "data-[drop-target=true]:bg-primary/5 data-[drop-target=true]:ring-2 data-[drop-target=true]:ring-primary/50",
                          "data-[focused=true]:ring-1 data-[focused=true]:ring-inset data-[focused=true]:ring-ring",
                          "data-[selected=true]:bg-primary/10",
                        )}
                      >
                        <FileIcon
                          kind={entry.kind}
                          ext={entry.ext}
                          mime={entry.mime}
                          className="size-8"
                        />
                        <span className="line-clamp-2 w-full break-words text-xs">
                          {entry.name}
                        </span>
                      </div>
                    </FileContextMenu>
                  );
                })}
              </div>
            );
          })}
        </div>
        {marquee.rect !== null && (
          <div
            aria-hidden
            data-slot="marquee-rect"
            className="pointer-events-none absolute rounded-sm border border-foreground/25 bg-foreground/10"
            style={{
              left: marquee.rect.left,
              top: marquee.rect.top,
              width: marquee.rect.width,
              height: marquee.rect.height,
            }}
          />
        )}
      </div>
    </div>
  );
}
