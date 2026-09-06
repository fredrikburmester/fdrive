"use client";

import type { FsEntry } from "@fdrive/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { INTERNAL_DND_TYPE, readDraggedPaths, writeDraggedPaths } from "@/lib/files/deps";
import { formatBytes, formatDate } from "@/lib/format";
import { FileContextMenu, type RowContextAction } from "./file-context-menu";
import { FileIcon } from "./file-icon";

export const FILE_ROW_HEIGHT = 36;

export interface ClickModifierKeys {
  shift: boolean;
  meta: boolean;
}

export interface FileListProps {
  entries: readonly FsEntry[];
  selected: ReadonlySet<string>;
  focusedPath: string | null;
  onEntryClick: (entry: FsEntry, modifiers: ClickModifierKeys) => void;
  onEntryDoubleClick: (entry: FsEntry) => void;
  onContextAction: (action: RowContextAction, entry: FsEntry) => void;
  getDragPaths: (entry: FsEntry) => string[];
  onInternalDrop: (paths: string[], targetPath: string) => void;
}

function modifiersFrom(event: ReactMouseEvent): ClickModifierKeys {
  return { shift: event.shiftKey, meta: event.metaKey || event.ctrlKey };
}

/** A virtualized, sortable-columns list view of a folder's entries. */
export function FileList({
  entries,
  selected,
  focusedPath,
  onEntryClick,
  onEntryDoubleClick,
  onContextAction,
  getDragPaths,
  onInternalDrop,
}: FileListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 10,
  });

  function handleDragStart(event: DragEvent<HTMLDivElement>, entry: FsEntry) {
    writeDraggedPaths(event.dataTransfer, getDragPaths(entry));
    event.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, entry: FsEntry) {
    if (entry.kind !== "dir") {
      return;
    }
    if (event.dataTransfer.types.includes(INTERNAL_DND_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, entry: FsEntry) {
    if (entry.kind !== "dir") {
      return;
    }
    const paths = readDraggedPaths(event.dataTransfer);
    if (paths !== null && paths.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      onInternalDrop(paths, entry.path);
    }
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto" data-slot="file-list">
      <div className="sticky top-0 z-10 flex h-9 items-center gap-3 border-border border-b bg-background/95 px-3 text-muted-foreground text-xs backdrop-blur supports-backdrop-filter:bg-background/75">
        <span className="w-4" />
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

          return (
            <FileContextMenu key={entry.path} entry={entry} onAction={onContextAction}>
              {/** biome-ignore lint/a11y/noStaticElementInteractions: this row supports drag-and-drop and click selection; keyboard activation is handled by the listing container's roving onKeyDown */}
              {/** biome-ignore lint/a11y/useKeyWithClickEvents: same as above */}
              <div
                data-path={entry.path}
                data-selected={isSelected}
                draggable
                onDragStart={(event) => handleDragStart(event, entry)}
                onDragOver={(event) => handleDragOver(event, entry)}
                onDrop={(event) => handleDrop(event, entry)}
                onClick={(event) => onEntryClick(entry, modifiersFrom(event))}
                onDoubleClick={() => onEntryDoubleClick(entry)}
                className="absolute inset-x-0 flex items-center gap-3 border-border/60 border-b px-3 text-sm data-selected:bg-primary/10 hover:bg-muted/60 data-focused:ring-1 data-focused:ring-inset data-focused:ring-ring"
                style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                data-focused={isFocused}
              >
                <Checkbox
                  checked={isSelected}
                  onClick={(event) => event.stopPropagation()}
                  onCheckedChange={() => onEntryClick(entry, { shift: false, meta: true })}
                  aria-label={`Select ${entry.name}`}
                />
                <FileIcon kind={entry.kind} ext={entry.ext} mime={entry.mime} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="w-20 shrink-0 text-right text-muted-foreground text-xs">
                  {entry.kind === "dir" ? "--" : formatBytes(entry.size)}
                </span>
                <span className="w-28 shrink-0 text-muted-foreground text-xs">
                  {formatDate(new Date(entry.modifiedAt))}
                </span>
              </div>
            </FileContextMenu>
          );
        })}
      </div>
    </div>
  );
}
