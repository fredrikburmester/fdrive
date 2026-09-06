"use client";

import type { FsEntry } from "@fdrive/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRightIcon } from "lucide-react";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { INTERNAL_DND_TYPE, readDraggedPaths, writeDraggedPaths } from "@/lib/files/deps";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
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
  entries: readonly FsEntry[];
  selected: ReadonlySet<string>;
  focusedPath: string | null;
  onEntryClick: (entry: FsEntry, modifiers: ClickModifierKeys) => void;
  onEntryDoubleClick: (entry: FsEntry) => void;
  onContextAction: (action: RowContextAction, entry: FsEntry) => void;
  getDragPaths: (entry: FsEntry) => string[];
  onInternalDrop: (paths: string[], targetPath: string) => void;
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
  treeDepths,
  treeExpanded,
  onToggleTreeExpand,
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
          const isTreeRow = treeDepths !== undefined;
          const depth = treeDepths?.get(entry.path) ?? 0;
          const isExpandedFolder = entry.kind === "dir" && (treeExpanded?.has(entry.path) ?? false);

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
                className="absolute inset-x-0 flex items-center gap-3 border-border/60 border-b px-3 text-sm hover:bg-muted/60 data-[focused=true]:ring-1 data-[focused=true]:ring-inset data-[focused=true]:ring-ring data-[selected=true]:bg-primary/10"
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
