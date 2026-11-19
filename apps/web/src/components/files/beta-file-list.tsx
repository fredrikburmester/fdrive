"use client";

import type { FsEntry, OfficeStatusResponse, ReceivedGrant, Tag } from "@fdrive/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRightIcon } from "lucide-react";
import type { DragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { TagDots } from "@/components/metadata/tag-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useIsMobile } from "@/hooks/use-mobile";
import { endDragSession, getActiveDragPaths, startDragSession, writeDownloadUrl } from "@/lib/dnd";
import { isBackgroundClick } from "@/lib/files/background-click";
import {
  DEFAULT_LIST_DENSITY,
  type ListDensity,
  listRowHeight,
  ROW_HEIGHTS,
} from "@/lib/files/density";
import {
  apiClient,
  INTERNAL_DND_TYPE,
  readDraggedPaths,
  writeDraggedPaths,
} from "@/lib/files/deps";
import { dropTargetState, effectFor } from "@/lib/files/dnd-targets";
import { isLink, LINK_TITLE } from "@/lib/files/links";
import { findRevealIndex, type ScrollRequest } from "@/lib/files/reveal";
import { contextEntries, selectionOf } from "@/lib/files/selection";
import { wantsThumbnail } from "@/lib/files/thumbnail";
import { sharedFolderCaption } from "@/lib/grants/format";
import { tagCheckState as computeTagCheckState } from "@/lib/metadata/tag-set";
import { useFormatters } from "@/lib/use-format-preferences";
import { cn } from "@/lib/utils";
import { createDragImageElement } from "./drag-image";
import {
  FileActionsMenu,
  FileContextMenu,
  type FileMenuProps,
  type RowContextAction,
} from "./file-context-menu";
import { FileIcon } from "./file-icon";
import type { ClickModifierKeys, FileListProps } from "./file-list";

const FILE_LIST_HEADER_HEIGHT = 36;

/** The icon column on a desktop row: as wide as a thumbnail, so names line up either way. */
const ICON_SLOT_PX = 24;
/** The space between a desktop row's icon and its name (`gap-2.5`). */
const ICON_GAP_PX = 10;

/** Indent per tree level on a desktop row: a child's icon sits under its parent's name. */
const TREE_INDENT_PX = ICON_SLOT_PX + ICON_GAP_PX;
/** Indent per tree level on a phone or touch screen, where a chevron column leads each row. */
const TOUCH_TREE_INDENT_PX = 20;

/** Shown while the row is hovered or the control has keyboard focus. */
const REVEAL_ON_HOVER = "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100";

const LIST_THUMBNAIL_SIZE = 256;

/**
 * A list row's icon: a thumbnail when `showThumbnail` is true and `wantsThumbnail` accepts the
 * file, else (or once that image fails to load) the entry's colored `FileIcon`. It fills the
 * row's icon column: 24px on desktop, 32px on phones (`mobile`), next to two lines of text.
 */
function ListRowIcon({
  entry,
  showThumbnail,
  mobile,
}: {
  entry: FsEntry;
  showThumbnail: boolean;
  mobile: boolean;
}) {
  const [errored, setErrored] = useState(false);

  if (!showThumbnail || errored || !wantsThumbnail(entry)) {
    return (
      <FileIcon
        kind={entry.kind}
        ext={entry.ext}
        mime={entry.mime}
        className={mobile ? "size-5" : "size-[18px]"}
      />
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: a thumbnail from the API, not a static asset next/image can optimize
    <img
      src={apiClient.thumbUrl(entry.path, LIST_THUMBNAIL_SIZE)}
      alt=""
      loading="lazy"
      decoding="async"
      className={cn("shrink-0 object-cover", mobile ? "size-8 rounded-sm" : "size-6 rounded-xs")}
      onError={() => setErrored(true)}
    />
  );
}

/**
 * The vertical lines that join a tree row to its ancestors, one per level above `depth`, each
 * under that ancestor's icon. Every row draws its own full-height pieces, so consecutive rows
 * of one folder join into one line.
 */
function TreeGuides({ depth }: { depth: number }) {
  if (depth === 0) {
    return null;
  }
  return Array.from({ length: depth }, (_, level) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: a level is the line's only identity
      key={level}
      aria-hidden="true"
      data-slot="tree-guide"
      className="pointer-events-none absolute inset-y-0 w-px bg-border"
      style={{ left: level * TREE_INDENT_PX + ICON_SLOT_PX / 2 }}
    />
  ));
}

const EMPTY_TAGS: readonly Tag[] = [];
const EMPTY_RECEIVED: readonly ReceivedGrant[] = [];
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

/**
 * Whether a click on a row really landed in it. React bubbles a portaled overlay's events
 * through the tree it was rendered from, so a pick in the row's own "More" menu would
 * otherwise reach the row and select or open it too.
 */
function inRow(event: ReactMouseEvent<HTMLElement>): boolean {
  return event.currentTarget.contains(event.target as Node);
}

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/**
 * The beta file list, on while the File list setting is "New (beta)". A virtualized,
 * sortable-columns list view of a folder's entries. Below `md` the Size and
 * Modified columns fold into a second line under each name, so names get the row's width.
 *
 * Rows are quiet until used: hover tints a row, and selection, keyboard focus and a drop target
 * tint it more, never with an outline. On a mouse, each row's "More" button shows on hover, and
 * in tree view a folder's icon turns into its disclosure chevron; on a touch screen they stay
 * visible, with the chevron in a column of its own. The checkbox column shows only while the
 * header's Select toggle is on. Rows keep their usual click behavior either way.
 */
export function BetaFileList({
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
  showOrganize = false,
  showChat = false,
  received = EMPTY_RECEIVED,
  scrollRequest = null,
  onScrollConsumed,
  showThumbnails = false,
  density = DEFAULT_LIST_DENSITY,
}: FileListProps) {
  const mobile = useIsMobile();
  const touch = useCoarsePointer();
  const [selecting, setSelecting] = useState(false);
  const hoverControls = !mobile && !touch;
  const isTreeRow = treeDepths !== undefined;
  const treeIndent = hoverControls ? TREE_INDENT_PX : TOUCH_TREE_INDENT_PX;
  const rowHeight = listRowHeight(density, mobile);
  const { formatBytes, formatDate } = useFormatters();
  const parentRef = useRef<HTMLDivElement>(null);
  const lastConsumedTokenRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const selectedCount = entries.filter((entry) => selected.has(entry.path)).length;
  const isSelectedAt = (index: number) => {
    const neighbor = entries[index];
    return neighbor !== undefined && selected.has(neighbor.path);
  };
  const allSelected = entries.length > 0 && selectedCount === entries.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    scrollMargin: FILE_LIST_HEADER_HEIGHT,
    scrollPaddingStart: FILE_LIST_HEADER_HEIGHT,
    overscan: 10,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure only when the density changes the estimate
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight]);

  useEffect(() => {
    if (!scrollRequest || lastConsumedTokenRef.current === scrollRequest.token) {
      return;
    }
    const index = findRevealIndex(entries, scrollRequest.path);
    if (index >= 0) {
      lastConsumedTokenRef.current = scrollRequest.token;
      virtualizer.scrollToIndex(index, { align: "auto" });
      onScrollConsumed?.(scrollRequest.token);
    }
  }, [scrollRequest, entries, virtualizer, onScrollConsumed]);

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
    writeDownloadUrl(
      event.dataTransfer,
      paths,
      entry,
      new URL(apiClient.downloadUrl(entry.path), window.location.href).href,
    );
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
        className={cn(
          "group/row sticky top-0 z-10 flex h-9 items-center gap-2.5 bg-background/95 text-muted-foreground text-xs backdrop-blur supports-backdrop-filter:bg-background/75",
          hoverControls ? "pr-3 pl-5" : "border-border border-b px-3",
        )}
      >
        {isTreeRow && !hoverControls && <span className="size-4 shrink-0" />}
        {selecting && (
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            onCheckedChange={onToggleSelectAll}
            aria-label={allSelected ? "Deselect all" : "Select all"}
          />
        )}
        {mobile ? (
          <span className="flex-1">{itemCountLabel(entries.length)}</span>
        ) : (
          <>
            <span className="flex-1" style={{ paddingLeft: ICON_SLOT_PX + ICON_GAP_PX }}>
              Name
            </span>
            <span className="w-20 text-right">Size</span>
            <span className="w-28">Modified</span>
          </>
        )}
        {/* Above the rows' More buttons, reaching left into the Modified column's empty end. */}
        <span className="relative flex size-7 shrink-0 items-center justify-end">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={selecting}
            onClick={() => setSelecting((on) => !on)}
            className={cn(
              "absolute right-0 text-muted-foreground",
              selecting && "font-medium text-primary hover:text-primary",
            )}
          >
            {selecting ? "Done" : "Select"}
          </Button>
        </span>
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index];
          if (entry === undefined) {
            return null;
          }
          const isSelected = selected.has(entry.path);
          // A run of selected rows reads as one block: only its outer corners are rounded.
          const joinsAbove = isSelected && isSelectedAt(virtualRow.index - 1);
          const joinsBelow = isSelected && isSelectedAt(virtualRow.index + 1);
          const isFocused = focusedPath === entry.path;
          const depth = treeDepths?.get(entry.path) ?? 0;
          const rowStyle = {
            height: virtualRow.size,
            transform: `translateY(${virtualRow.start - FILE_LIST_HEADER_HEIGHT}px)`,
            // On a mouse the indent goes inside the row, after the checkbox column, so
            // checkboxes stay in one column and the tree guides line up with the icons.
            paddingLeft: hoverControls ? 12 : 12 + depth * treeIndent,
          };
          const indentStyle = hoverControls ? { paddingLeft: depth * treeIndent } : undefined;
          const iconSlot = cn(
            "relative flex shrink-0 items-center justify-center",
            mobile ? "size-8" : "size-6",
          );
          if (isLink(entry)) {
            // Shown so its name stays visible, and nothing more: no menu, no
            // selection, no drag, nothing to open.
            return (
              <div
                key={entry.path}
                data-path={entry.path}
                aria-disabled="true"
                title={LINK_TITLE}
                className={cn(
                  "absolute flex items-center gap-2.5 pr-1 text-muted-foreground text-sm",
                  hoverControls ? "inset-x-2 rounded-md" : "inset-x-0 border-border/60 border-b",
                )}
                style={rowStyle}
              >
                {isTreeRow && !hoverControls && <span className="size-4 shrink-0" />}
                {selecting && <span className="size-4 shrink-0" />}
                <div
                  className="relative flex min-w-0 flex-1 items-center gap-2.5 self-stretch opacity-60"
                  style={indentStyle}
                >
                  {hoverControls && <TreeGuides depth={depth} />}
                  <span className={iconSlot}>
                    <ListRowIcon
                      key={entry.path}
                      entry={entry}
                      showThumbnail={showThumbnails}
                      mobile={mobile}
                    />
                  </span>
                  {mobile ? (
                    <RowText name={entry.name} detail={formatDate(new Date(entry.modifiedAt))} />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className="w-20 shrink-0 text-right text-xs">--</span>
                      <span className="w-28 shrink-0 text-xs">
                        {formatDate(new Date(entry.modifiedAt))}
                      </span>
                    </>
                  )}
                </div>
                <span className="size-7 shrink-0" />
              </div>
            );
          }
          const isFolder = entry.kind === "dir";
          const isExpandedFolder = isFolder && (treeExpanded?.has(entry.path) ?? false);
          const group = contextEntries(entry, entries, selected);
          const groupPaths = group.map((candidate) => candidate.path);
          const sharedBy = sharedFolderCaption(entry.path, received);
          const menu: FileMenuProps = {
            officeStatus,
            entry,
            onAction: onContextAction,
            selection: selectionOf(group),
            hideMoveCopy,
            showReveal,
            hideArchive,
            showOrganize,
            showChat,
            tags,
            tagCheckState: (tagId) =>
              computeTagCheckState(
                group.map((candidate) => ({ tagIds: candidate.meta?.tagIds ?? [] })),
                tagId,
              ),
            onToggleTag: (tagId, checked) => onToggleTag(groupPaths, tagId, checked),
            onOpenTagsEditor: () => onOpenTagsEditor(group),
            favorite: groupFavorite(group),
            onToggleFavorite: (next) => onToggleFavorite(groupPaths, next),
            received,
          };
          const expandLabel = isExpandedFolder ? `Collapse ${entry.name}` : `Expand ${entry.name}`;
          const toggleExpanded = (event: ReactMouseEvent) => {
            event.stopPropagation();
            onToggleTreeExpand?.(entry);
          };
          // On a mouse, a folder's chevron takes its icon's place while the row is hovered.
          const chevronOverIcon = isTreeRow && isFolder && hoverControls;

          return (
            <FileContextMenu key={entry.path} {...menu}>
              {/** biome-ignore lint/a11y/noStaticElementInteractions: this row supports drag-and-drop and click selection; keyboard activation is handled by the listing container's roving onKeyDown */}
              {/** biome-ignore lint/a11y/useKeyWithClickEvents: same as above */}
              <div
                data-path={entry.path}
                data-selected={isSelected}
                data-drop-target={dropTarget === entry.path}
                onDragOver={(event) => handleDragOver(event, entry)}
                onDragLeave={() => handleDragLeave(entry)}
                onDrop={(event) => handleDrop(event, entry)}
                onClick={(event) => {
                  if (inRow(event)) onEntryClick(entry, modifiersFrom(event));
                }}
                onDoubleClick={(event) => {
                  if (inRow(event)) onEntryDoubleClick(entry);
                }}
                className={cn(
                  "group/row absolute flex items-center gap-2.5 pr-1 text-sm not-data-[selected=true]:hover:bg-muted/60 data-[focused=true]:not-data-[selected=true]:bg-muted data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[drop-target=true]:bg-primary/15",
                  hoverControls ? "inset-x-2 rounded-md" : "inset-x-0 border-border/60 border-b",
                  hoverControls && joinsAbove && "rounded-t-none",
                  hoverControls && joinsBelow && "rounded-b-none",
                )}
                style={rowStyle}
                data-focused={isFocused}
              >
                {isTreeRow &&
                  !hoverControls &&
                  (isFolder ? (
                    <button
                      type="button"
                      onClick={toggleExpanded}
                      onDoubleClick={(event) => event.stopPropagation()}
                      aria-label={expandLabel}
                      aria-expanded={isExpandedFolder}
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
                {selecting && (
                  <Checkbox
                    checked={isSelected}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onCheckedChange={() => onEntryClick(entry, { shift: false, meta: true })}
                    aria-label={`Select ${entry.name}`}
                  />
                )}
                {/**
                 * Only this inner wrapper (the icon through the date column) is
                 * `draggable`, not the row itself: the row's own padding and
                 * the gaps around its checkbox and "More" button stay plain,
                 * un-draggable background, so the browser never mistakes a
                 * plain click there for the start of a native HTML5 drag.
                 */}
                {/** biome-ignore lint/a11y/noStaticElementInteractions: this is the row's drag handle; click/selection semantics live on the row above it */}
                <div
                  draggable
                  onDragStart={(event) => handleDragStart(event, entry)}
                  onDragEnd={handleDragEnd}
                  className="relative flex min-w-0 flex-1 items-center gap-2.5 self-stretch"
                  style={indentStyle}
                >
                  {hoverControls && <TreeGuides depth={depth} />}
                  <span className={iconSlot}>
                    <span
                      className={cn(
                        "flex items-center justify-center",
                        chevronOverIcon && "group-hover/row:opacity-0",
                      )}
                    >
                      <ListRowIcon
                        key={entry.path}
                        entry={entry}
                        showThumbnail={showThumbnails}
                        mobile={mobile}
                      />
                    </span>
                    {chevronOverIcon && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={toggleExpanded}
                        onDoubleClick={(event) => event.stopPropagation()}
                        aria-label={expandLabel}
                        aria-expanded={isExpandedFolder}
                        className="absolute inset-0 flex items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover/row:opacity-100"
                      >
                        <ChevronRightIcon
                          className={cn(
                            "size-4 transition-transform",
                            isExpandedFolder && "rotate-90",
                          )}
                        />
                      </button>
                    )}
                  </span>
                  {mobile ? (
                    <>
                      <RowText
                        name={entry.name}
                        detail={[
                          isFolder ? null : formatBytes(entry.size),
                          formatDate(new Date(entry.modifiedAt)),
                          sharedBy,
                        ]
                          .filter((part) => part !== null)
                          .join(" · ")}
                      >
                        <TagDots tags={tags} tagIds={entry.meta?.tagIds ?? []} />
                      </RowText>
                      {isFolder && !isTreeRow && (
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {sharedBy !== null && (
                        <span className="shrink-0 text-muted-foreground text-xs">{sharedBy}</span>
                      )}
                      <TagDots tags={tags} tagIds={entry.meta?.tagIds ?? []} />
                      <span className="w-20 shrink-0 text-right text-muted-foreground text-xs group-data-[selected=true]/row:text-accent-foreground/75">
                        {isFolder ? "--" : formatBytes(entry.size)}
                      </span>
                      <span className="w-28 shrink-0 text-muted-foreground text-xs group-data-[selected=true]/row:text-accent-foreground/75">
                        {formatDate(new Date(entry.modifiedAt))}
                      </span>
                    </>
                  )}
                </div>
                <FileActionsMenu
                  {...menu}
                  className={cn(
                    "shrink-0 text-muted-foreground hover:text-foreground group-data-[selected=true]/row:text-accent-foreground",
                    hoverControls && `${REVEAL_ON_HOVER} data-popup-open:opacity-100`,
                  )}
                />
              </div>
            </FileContextMenu>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A phone row's text: the name on its own line, at full width, with the size, date and
 * any sharing caption on a smaller line under it, followed by `children` (the tag dots).
 */
function RowText({
  name,
  detail,
  children,
}: {
  name: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-[15px] leading-5">{name}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
        <span className="truncate">{detail}</span>
        {children}
      </span>
    </div>
  );
}
