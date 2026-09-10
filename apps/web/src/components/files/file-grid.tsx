"use client";

import type { FsEntry, OfficeStatusResponse, ProviderCapabilities, Tag } from "@fdrive/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TagDots } from "@/components/metadata/tag-dots";
import { Checkbox } from "@/components/ui/checkbox";
import { apiClient } from "@/lib/api/client";
import { endDragSession, getActiveDragPaths, startDragSession } from "@/lib/dnd";
import { isBackgroundClick } from "@/lib/files/background-click";
import { INTERNAL_DND_TYPE, readDraggedPaths, writeDraggedPaths } from "@/lib/files/deps";
import { dropTargetState, effectFor } from "@/lib/files/dnd-targets";
import { computeGridLayout, readGridWidth, writeGridWidth } from "@/lib/files/grid-layout";
import { findRevealIndex, gridRowForIndex, type ScrollRequest } from "@/lib/files/reveal";
import { contextEntries } from "@/lib/files/selection";
import { wantsGridThumbnail } from "@/lib/files/thumbnail";
import { DEFAULT_CAPABILITIES, selectionOf } from "@/lib/identity/capabilities";
import { tagCheckState as computeTagCheckState } from "@/lib/metadata/tag-set";
import { cn } from "@/lib/utils";
import { createDragImageElement } from "./drag-image";
import { FileContextMenu, type RowContextAction } from "./file-context-menu";
import { FileIcon } from "./file-icon";
import type { ClickModifierKeys } from "./file-list";
import { ListingSkeleton } from "./listing-skeleton";

/** A grid tile's fixed footprint, in pixels: used to compute how many
 * columns fit and, in `ListingSkeleton`, to size its placeholder tiles. */
export const GRID_TILE_WIDTH = 112;
export const GRID_TILE_HEIGHT = 128;
/** The gap between tiles, in pixels: matches the `gap-1` utility (0.25rem)
 * on each virtualized row, so the column math lines up with the CSS. */
export const GRID_GAP = 4;
const TILE_WIDTH = GRID_TILE_WIDTH;
const TILE_HEIGHT = GRID_TILE_HEIGHT;

/**
 * `useLayoutEffect` measures the container synchronously after it commits
 * but before the browser paints, which is what lets the grid pick its real
 * column count before the first frame instead of flashing a fallback
 * layout. It has no DOM to measure (and warns) when rendered outside a
 * browser, so it falls back to the ordinary, post-paint `useEffect` there.
 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface FileGridProps {
  officeStatus?: OfficeStatusResponse | undefined;
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
  /** Clears the selection, for a plain click on empty listing space. */
  onClearSelection: () => void;
  /** Every tag known to the account, for each tile's tag dots and the
   * "Tags" context menu submenu. Defaults to none. */
  tags?: readonly Tag[];
  /** Adds or removes `tagId` on every entry in the group a tile's context
   * menu action would apply to (see `contextEntries`). Defaults to a no-op. */
  onToggleTag?: (paths: readonly string[], tagId: string, checked: boolean) => void;
  /** Opens the full tag editor for the group of entries a tile's context
   * menu action would apply to. Defaults to a no-op. */
  onOpenTagsEditor?: (entries: readonly FsEntry[]) => void;
  /** Favorites (or unfavorites) every entry in the group a tile's context
   * menu action would apply to. Defaults to a no-op. */
  onToggleFavorite?: (paths: readonly string[], next: boolean) => void;
  /** Hides "Move to" and "Copy to" for a virtual listing. */
  hideMoveCopy?: boolean;
  /** Shows "Reveal in folder" for a virtual listing. */
  showReveal?: boolean;
  /** Hides archive actions for a virtual listing. */
  hideArchive?: boolean;
  /** What the active login's storage can do, for every tile's context menu
   * (see `FileContextMenu`). Defaults to `DEFAULT_CAPABILITIES`. */
  capabilities?: ProviderCapabilities;
  /** A request to scroll a specific entry into view, identified by unique token. */
  scrollRequest?: ScrollRequest | null;
  /** Callback fired after the virtualizer has scrolled to the requested entry. */
  onScrollConsumed?: (token: number) => void;
  /** Whether tiles may show image thumbnails at all; false for a login whose provider is not indexed. Defaults to true. */
  thumbnails?: boolean;
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

const GRID_THUMBNAIL_SIZE = 256;

/**
 * A grid tile's icon slot: an image thumbnail for a file `wantsGridThumbnail`
 * accepts, falling back to `FileIcon` for good once that thumbnail request
 * fails (or permanently, for every other entry). The fallback state is keyed
 * by `entry.path` via `key` on the caller, so navigating to a different entry
 * at the same tile position starts from the thumbnail again.
 */
function GridTileIcon({ entry, thumbnails }: { entry: FsEntry; thumbnails: boolean }) {
  const [errored, setErrored] = useState(false);

  // The slot is a fixed 56px square so tiles with an icon and tiles with a
  // picture line up; the icon keeps its 32px size centred inside it.
  if (errored || !thumbnails || !wantsGridThumbnail(entry)) {
    return (
      <span className="flex size-14 shrink-0 items-center justify-center">
        <FileIcon kind={entry.kind} ext={entry.ext} mime={entry.mime} className="size-8" />
      </span>
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: a thumbnail from the API, not a static asset next/image can optimize
    <img
      src={apiClient.thumbUrl(entry.path, GRID_THUMBNAIL_SIZE)}
      alt=""
      loading="lazy"
      decoding="async"
      className="size-14 shrink-0 rounded-md object-cover ring-1 ring-border"
      onError={() => setErrored(true)}
    />
  );
}

/** A virtualized grid of tiles, one row of tiles per virtualized "row". */
export function FileGrid({
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
  tags = EMPTY_TAGS,
  onToggleTag = NO_OP_TOGGLE_TAG,
  onOpenTagsEditor = NO_OP_OPEN_TAGS_EDITOR,
  onToggleFavorite = NO_OP_TOGGLE_FAVORITE,
  hideMoveCopy = false,
  showReveal = false,
  hideArchive = false,
  capabilities = DEFAULT_CAPABILITIES,
  scrollRequest = null,
  onScrollConsumed,
  thumbnails = true,
}: FileGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const lastConsumedTokenRef = useRef<number | null>(null);
  // Seeded from the last container width this grid measured, persisted
  // across mounts (view-mode switches, folder navigations, reloads) so a
  // fresh mount already knows roughly how wide it will be, before it has
  // measured anything itself.
  const [seededWidth] = useState(() =>
    typeof window === "undefined" ? 0 : readGridWidth(window.localStorage),
  );
  const [containerWidth, setContainerWidth] = useState(seededWidth);
  // True once a real measurement (seeded or freshly observed) is known.
  // Cold starts, with nothing persisted yet, start out false: rendering the
  // grid's `ListingSkeleton` placeholder below instead of guessing at a
  // one-column layout, until the first real measurement lands.
  const [hasMeasured, setHasMeasured] = useState(seededWidth > 0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const selectedCount = entries.filter((entry) => selected.has(entry.path)).length;
  const allSelected = entries.length > 0 && selectedCount === entries.length;
  const someSelected = selectedCount > 0 && !allSelected;

  useIsomorphicLayoutEffect(() => {
    const el = parentRef.current;
    if (el === null) {
      return;
    }
    function applyWidth(width: number) {
      if (width <= 0) {
        return;
      }
      setContainerWidth(width);
      setHasMeasured(true);
      writeGridWidth(window.localStorage, width);
    }
    applyWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((observedEntries) => {
      const entry = observedEntries[0];
      if (entry !== undefined) {
        applyWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { columns } = computeGridLayout(containerWidth, TILE_WIDTH, GRID_GAP);
  const rowCount = Math.ceil(entries.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => TILE_HEIGHT,
    overscan: 4,
  });

  useEffect(() => {
    if (!scrollRequest || lastConsumedTokenRef.current === scrollRequest.token) {
      return;
    }
    const index = findRevealIndex(entries, scrollRequest.path);
    if (index >= 0) {
      lastConsumedTokenRef.current = scrollRequest.token;
      const rowIndex = gridRowForIndex(index, columns);
      virtualizer.scrollToIndex(rowIndex, { align: "auto" });
      onScrollConsumed?.(scrollRequest.token);
    }
  }, [scrollRequest, entries, columns, virtualizer, onScrollConsumed]);

  const onClearSelectionRef = useRef(onClearSelection);
  onClearSelectionRef.current = onClearSelection;

  useEffect(() => {
    const container = parentRef.current;
    if (container === null) {
      return;
    }
    // A native listener, not a JSX `onClick` prop: a portaled overlay (a
    // context menu, a dialog) is a React-tree descendant of this grid even
    // though it renders outside the container in the real DOM, and React's
    // synthetic events still bubble through the React tree across that
    // portal boundary. A JSX `onClick` here would misfire and clear the
    // selection for a click on that unrelated, portaled content; a native
    // listener only ever fires for events whose real DOM target is
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
        {!hasMeasured ? (
          <ListingSkeleton variant="grid" />
        ) : (
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
                    const group = contextEntries(entry, entries, selected);
                    const groupPaths = group.map((candidate) => candidate.path);

                    return (
                      <FileContextMenu
                        officeStatus={officeStatus}
                        key={entry.path}
                        entry={entry}
                        onAction={onContextAction}
                        selection={selectionOf(group)}
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
                        capabilities={capabilities}
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
                          <GridTileIcon key={entry.path} entry={entry} thumbnails={thumbnails} />
                          <span className="line-clamp-2 w-full break-words text-xs">
                            {entry.name}
                          </span>
                          <TagDots tags={tags} tagIds={entry.meta?.tagIds ?? []} />
                        </div>
                      </FileContextMenu>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
