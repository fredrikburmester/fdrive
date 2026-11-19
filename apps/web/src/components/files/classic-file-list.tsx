"use client";

import type { FsEntry, OfficeStatusResponse, ReceivedGrant, Tag } from "@fdrive/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRightIcon } from "lucide-react";
import type { DragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { TagDots } from "@/components/metadata/tag-dots";
import { Checkbox } from "@/components/ui/checkbox";
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
import { FileContextMenu, type RowContextAction } from "./file-context-menu";
import { FileIcon } from "./file-icon";
import type { ClickModifierKeys, FileListProps } from "./file-list";

const FILE_LIST_HEADER_HEIGHT = 36;

/** Indent, in pixels, added per tree depth level in tree view. */
const TREE_INDENT_PX = 20;

const LIST_THUMBNAIL_SIZE = 256;

/**
 * A list row's icon slot: a 24px image thumbnail when `showThumbnail` is true
 * and `wantsThumbnail` accepts the file, falling back to a 24px container holding
 * `FileIcon` if the image fails to load or for non-image entries to preserve layout.
 * On phones (`mobile`) the slot is always a 32px box with a larger icon, next to the
 * row's two lines of text.
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
  const icon = (
    <FileIcon
      kind={entry.kind}
      ext={entry.ext}
      mime={entry.mime}
      className={cn(mobile && "size-5")}
    />
  );

  if (!showThumbnail && !mobile) {
    return icon;
  }

  if (!showThumbnail || errored || !wantsThumbnail(entry)) {
    return (
      <div
        className={cn("flex shrink-0 items-center justify-center", mobile ? "size-8" : "size-6")}
      >
        {icon}
      </div>
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

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** The file list as it was before the beta design (`BetaFileList`), kept while both can be
 * switched between. A virtualized, sortable-columns list view of a folder's entries. Below `md` the Size and
 * Modified columns fold into a second line under each name, so names get the row's width. */
export function ClassicFileList({
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
  encrypted = false,
  showOrganize = false,
  showChat = false,
  received = EMPTY_RECEIVED,
  scrollRequest = null,
  onScrollConsumed,
  showThumbnails = false,
  density = DEFAULT_LIST_DENSITY,
}: FileListProps) {
  const mobile = useIsMobile();
  const rowHeight = listRowHeight(density, mobile);
  const { formatBytes, formatDate } = useFormatters();
  const parentRef = useRef<HTMLDivElement>(null);
  const lastConsumedTokenRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const selectedCount = entries.filter((entry) => selected.has(entry.path)).length;
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
    // A file of an encrypted folder would arrive as ciphertext; the browser decrypts downloads itself.
    if (!encrypted)
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
        className="sticky top-0 z-10 flex h-9 items-center gap-3 border-border border-b bg-background/95 px-3 text-muted-foreground text-xs backdrop-blur supports-backdrop-filter:bg-background/75"
      >
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onCheckedChange={onToggleSelectAll}
          aria-label={allSelected ? "Deselect all" : "Select all"}
        />
        {mobile ? (
          <span className="flex-1">{itemCountLabel(entries.length)}</span>
        ) : (
          <>
            <span className="flex-1">Name</span>
            <span className="w-20 text-right">Size</span>
            <span className="w-28">Modified</span>
          </>
        )}
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
          const rowStyle = {
            height: virtualRow.size,
            transform: `translateY(${virtualRow.start - FILE_LIST_HEADER_HEIGHT}px)`,
            paddingLeft: 12 + depth * TREE_INDENT_PX,
            paddingRight: 12,
          };
          if (isLink(entry)) {
            // Shown so its name stays visible, and nothing more: no menu, no
            // selection, no drag, nothing to open.
            return (
              <div
                key={entry.path}
                data-path={entry.path}
                aria-disabled="true"
                title={LINK_TITLE}
                className="absolute inset-x-0 flex items-center gap-3 border-border/60 border-b px-3 text-muted-foreground text-sm"
                style={rowStyle}
              >
                {isTreeRow && <span className="size-4 shrink-0" />}
                <div className="flex min-w-0 flex-1 items-center gap-3 opacity-60">
                  <span className="size-4 shrink-0" />
                  <ListRowIcon
                    key={entry.path}
                    entry={entry}
                    showThumbnail={showThumbnails}
                    mobile={mobile}
                  />
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
              </div>
            );
          }
          const isExpandedFolder = entry.kind === "dir" && (treeExpanded?.has(entry.path) ?? false);
          const group = contextEntries(entry, entries, selected);
          const groupPaths = group.map((candidate) => candidate.path);
          const sharedBy = sharedFolderCaption(entry.path, received);

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
              encrypted={encrypted}
              showOrganize={showOrganize}
              showChat={showChat}
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
              received={received}
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
                style={rowStyle}
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
                  <ListRowIcon
                    key={entry.path}
                    entry={entry}
                    showThumbnail={showThumbnails}
                    mobile={mobile}
                  />
                  {mobile ? (
                    <>
                      <RowText
                        name={entry.name}
                        detail={[
                          entry.kind === "dir" ? null : formatBytes(entry.size),
                          formatDate(new Date(entry.modifiedAt)),
                          sharedBy,
                        ]
                          .filter((part) => part !== null)
                          .join(" · ")}
                      >
                        <TagDots tags={tags} tagIds={entry.meta?.tagIds ?? []} />
                      </RowText>
                      {entry.kind === "dir" && !isTreeRow && (
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
                      <span className="w-20 shrink-0 text-right text-muted-foreground text-xs">
                        {entry.kind === "dir" ? "--" : formatBytes(entry.size)}
                      </span>
                      <span className="w-28 shrink-0 text-muted-foreground text-xs">
                        {formatDate(new Date(entry.modifiedAt))}
                      </span>
                    </>
                  )}
                </div>
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
