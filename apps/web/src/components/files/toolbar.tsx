"use client";

import type { ProviderCapabilities } from "@fdrive/contracts";
import type { SortDirection, SortKey } from "@fdrive/core";
import {
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderPlusIcon,
  FolderUpIcon,
  LayoutGridIcon,
  ListIcon,
  ListTreeIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PlusIcon,
  SparklesIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { DragEvent } from "react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { getActiveDragPaths, INTERNAL_DND_TYPE, readDraggedPaths } from "@/lib/dnd";
import type { NewFileKind } from "@/lib/editor/new-file";
import { type BreadcrumbWidths, breadcrumbLayout } from "@/lib/files/breadcrumb-layout";
import { LIST_DENSITIES, type ListDensity } from "@/lib/files/density";
import { dropTargetState, effectFor } from "@/lib/files/dnd-targets";
import { GRID_SIZES, type GridSize } from "@/lib/files/grid-size";
import { type BreadcrumbEntry, buildBreadcrumbs } from "@/lib/files/path-url";
import type { SortSpec } from "@/lib/files/sorting";
import { toolbarVisibility } from "@/lib/files/toolbar-visibility";
import type { ViewMode } from "@/lib/files/view-mode";
import {
  type BrowserSelection,
  canDownload,
  DEFAULT_CAPABILITIES,
} from "@/lib/identity/capabilities";
import { OFFICE_DOCUMENT_LABELS, type OfficeDocumentKind } from "@/lib/office/new-document";
import { cn } from "@/lib/utils";

const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  size: "Size",
  modifiedAt: "Modified",
  ext: "Kind",
};

const VIEW_MODE_ICONS: Record<ViewMode, typeof ListIcon> = {
  list: ListIcon,
  grid: LayoutGridIcon,
  tree: ListTreeIcon,
};

/**
 * Asserts a dynamically built path is a valid Next.js route. Next's typed
 * routes can only verify string literals at compile time; paths built at
 * runtime from `buildBreadcrumbs` need this explicit (safe, since they are
 * always same-origin app paths) cast.
 */
function toRoute(href: string): Route {
  return href as Route;
}

export interface FilesBreadcrumbProps {
  path: string;
  /** Called when an internal drag drops onto a breadcrumb segment (moving
   * the dragged entries up to that ancestor folder, or the current one). */
  onInternalDrop?: (paths: string[], targetPath: string, effect: "move" | "copy") => void;
}

/** Shared by the visible crumbs and their hidden measuring copies, so both
 * take the same width. */
const CRUMB_CLASS = "max-w-48 truncate rounded-sm px-1";

/** The current folder's breadcrumb trail. Desktop shows every crumb while
 * the trail fits, truncating long names first and hiding the shallowest
 * ancestors behind an ellipsis only once names would get too narrow; below
 * `md` it always truncates from the left instead, keeping only the current
 * folder inline so it is never pushed off narrow screens (see
 * `breadcrumbLayout`). */
export function FilesBreadcrumb({ path, onInternalDrop }: FilesBreadcrumbProps) {
  const isMobile = useIsMobile();
  const crumbs = buildBreadcrumbs(path);
  const { navRef, measureRef, widths } = useTrailWidths(path, !isMobile);
  const layout = breadcrumbLayout(crumbs, isMobile, widths);

  return (
    <Breadcrumb ref={navRef} className="relative min-w-0 flex-1">
      <BreadcrumbList className="min-w-0 flex-nowrap">
        {layout.head.map((crumb, index) => (
          <CrumbRow
            key={crumb.path}
            crumb={crumb}
            isLast={!layout.collapsed && index === layout.head.length - 1}
            maxWidth={layout.nameMaxWidth}
            onInternalDrop={onInternalDrop}
          />
        ))}
        {layout.collapsed && (
          <>
            <BreadcrumbItem>
              <DropdownMenu>
                <DropdownMenuTrigger>
                  <BreadcrumbEllipsis className="cursor-pointer hover:bg-muted hover:text-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {layout.hidden.map((crumb) => (
                    <DropdownMenuItem key={crumb.path} render={<Link href={toRoute(crumb.href)} />}>
                      {crumb.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            {layout.tail.map((crumb, index) => (
              <CrumbRow
                key={crumb.path}
                crumb={crumb}
                isLast={index === layout.tail.length - 1}
                maxWidth={layout.nameMaxWidth}
                onInternalDrop={onInternalDrop}
              />
            ))}
          </>
        )}
      </BreadcrumbList>
      {!isMobile && (
        // The whole trail, laid out off to the side with the ellipsis after
        // Home, for `useTrailWidths` to measure. Names come from CSS
        // `content` rather than text nodes, so text queries and screen
        // readers only ever find the visible crumbs.
        <BreadcrumbList
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute top-0 left-0 w-max flex-nowrap"
        >
          {crumbs.map((crumb, index) => (
            <Fragment key={crumb.path}>
              {index > 0 && <BreadcrumbSeparator />}
              {index === 1 && (
                <>
                  <BreadcrumbItem data-measure="ellipsis">
                    <BreadcrumbEllipsis />
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                </>
              )}
              <BreadcrumbItem data-measure="crumb">
                <span
                  data-name={crumb.name}
                  className={cn(CRUMB_CLASS, "after:content-[attr(data-name)]")}
                />
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      )}
    </Breadcrumb>
  );
}

/**
 * Measures the hidden full trail and the width it has, again whenever
 * either resizes (the window, the sidebar or inspector opening, web fonts
 * loading). Runs before paint, so a trail that does not fit never flashes
 * whole. A measurement is tagged with its `path` and ignored for any other,
 * so a new folder's trail is never laid out with the previous one's widths.
 */
function useTrailWidths(path: string, enabled: boolean) {
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLOListElement>(null);
  const [measured, setMeasured] = useState<{ path: string; widths: BreadcrumbWidths } | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const list = measureRef.current;
    if (!enabled || nav === null || list === null) {
      return;
    }
    const update = () => setMeasured({ path, widths: measureTrail(nav, list) });
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    observer.observe(list);
    return () => observer.disconnect();
  }, [path, enabled]);

  return { navRef, measureRef, widths: measured?.path === path ? measured.widths : null };
}

/** Each measured segment's separator and gaps run from its right edge to
 * the next segment's left edge. */
function measureTrail(nav: HTMLElement, list: HTMLOListElement): BreadcrumbWidths {
  const segments = Array.from(list.querySelectorAll<HTMLElement>("[data-measure]"), (element) => ({
    kind: element.dataset.measure,
    rect: element.getBoundingClientRect(),
  }));
  const end = list.getBoundingClientRect().right;
  const spans = segments.map((segment, index) => ({
    kind: segment.kind,
    name: segment.rect.width,
    trailing: (segments[index + 1]?.rect.left ?? end) - segment.rect.right,
  }));
  const ellipsis = spans.find((span) => span.kind === "ellipsis");
  return {
    available: nav.getBoundingClientRect().width,
    crumbs: spans
      .filter((span) => span.kind === "crumb")
      .map(({ name, trailing }) => ({ name, trailing })),
    ellipsis: ellipsis ? ellipsis.name + ellipsis.trailing : 0,
  };
}

interface CrumbRowProps {
  crumb: BreadcrumbEntry;
  isLast: boolean;
  /** Truncates the name to this many pixels so the trail fits; `null` keeps it whole. */
  maxWidth: number | null;
  onInternalDrop?:
    | ((paths: string[], targetPath: string, effect: "move" | "copy") => void)
    | undefined;
}

/** One breadcrumb segment, including Home; every segment (even the current,
 * non-linked one) accepts an internal drag-and-drop, so dropping a file onto
 * an ancestor moves it up out of the current folder, matching Finder's path
 * bar. */
function CrumbRow({ crumb, isLast, maxWidth, onInternalDrop }: CrumbRowProps) {
  const [isDropTarget, setIsDropTarget] = useState(false);

  const style = maxWidth === null ? undefined : { maxWidth };

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes(INTERNAL_DND_TYPE)) {
      return;
    }
    const draggedPaths = getActiveDragPaths() ?? [];
    if (dropTargetState(draggedPaths, crumb.path) !== "valid") {
      event.dataTransfer.dropEffect = "none";
      setIsDropTarget(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = effectFor(event);
    setIsDropTarget(true);
  }

  function handleDragLeave() {
    setIsDropTarget(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    const paths = readDraggedPaths(event.dataTransfer);
    setIsDropTarget(false);
    if (paths !== null && paths.length > 0) {
      event.preventDefault();
      onInternalDrop?.(paths, crumb.path, effectFor(event));
    }
  }

  return (
    <>
      <BreadcrumbItem className="min-w-0">
        {isLast ? (
          <BreadcrumbPage
            data-drop-target={isDropTarget}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={style}
            className={cn(
              CRUMB_CLASS,
              "data-[drop-target=true]:bg-primary/5 data-[drop-target=true]:ring-2 data-[drop-target=true]:ring-primary/50",
            )}
          >
            {crumb.name}
          </BreadcrumbPage>
        ) : (
          <BreadcrumbLink
            render={<Link href={toRoute(crumb.href)} />}
            data-drop-target={isDropTarget}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={style}
            className={cn(
              CRUMB_CLASS,
              "data-[drop-target=true]:bg-primary/5 data-[drop-target=true]:ring-2 data-[drop-target=true]:ring-primary/50",
            )}
          >
            {crumb.name}
          </BreadcrumbLink>
        )}
      </BreadcrumbItem>
      {!isLast && <BreadcrumbSeparator />}
    </>
  );
}

export interface FolderViewActions {
  pinned: boolean;
  disabled: boolean;
  error: boolean;
  retry: () => void;
  useDefault: () => void;
  makeDefault: () => void;
}

export interface FilesToolbarActionsProps {
  onNewOfficeDocument?: ((kind: OfficeDocumentKind) => void) | undefined;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  folderView?: FolderViewActions | undefined;
  sortSpec: SortSpec;
  onSortSpecChange: (spec: SortSpec) => void;
  /** Per-folder sort pinning, in the same shape as `folderView`. Absent for virtual listings. */
  folderSort?: FolderViewActions | undefined;
  /** How tall list and tree rows are. */
  density: ListDensity;
  onDensityChange: (density: ListDensity) => void;
  /** How large grid tiles are. */
  gridSize: GridSize;
  onGridSizeChange: (size: GridSize) => void;
  onNewFolder: () => void;
  onNewFile: (kind: NewFileKind) => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** The files and folders currently selected; shows an "N selected" pill when any. */
  selection: BrowserSelection;
  /**
   * What the active login's storage can do: hides Download when the
   * selection needs a zip the provider cannot build (`zip`), the Office
   * document kinds under New without `office`, and "Show thumbnails"
   * without `index`. Defaults to `DEFAULT_CAPABILITIES`.
   */
  capabilities?: ProviderCapabilities | undefined;
  onClearSelection: () => void;
  /** Duplicates the single selected entry. Only enabled for a one-entry selection. */
  onDuplicateSelection: () => void;
  /** Opens the compress dialog for the current selection (any size). */
  onCompressSelection: () => void;
  /** Asks the assistant where the selection belongs. Hidden when AI is not set up. */
  onOrganizeSelection?: (() => void) | undefined;
  /** Adds the selection to the chat panel; shown when AI is set up. */
  onAddSelectionToChat?: (() => void) | undefined;
  /** Downloads the currently selected entries (single direct download or zip). */
  onDownloadSelection: () => void;
  /** Whether image thumbnails are shown in list view. */
  showThumbnails: boolean;
  /** Toggles the show-thumbnails preference for list view. */
  onShowThumbnailsChange: (show: boolean) => void;
  /**
   * Why nothing can be added to this folder (a folder shared to view, or
   * `Shared with me` itself), or absent when it can: New, Upload and
   * Duplicate are then off, with the reason as their tooltip.
   */
  writeBlock?: string | null | undefined;
}

interface ViewSortMenuItemsProps {
  /** Whether the login's provider is indexed, so thumbnails can exist at all. */
  thumbnailsAvailable: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  folderView?: FolderViewActions | undefined;
  sortSpec: SortSpec;
  onSortSpecChange: (spec: SortSpec) => void;
  folderSort?: FolderViewActions | undefined;
  density: ListDensity;
  onDensityChange: (density: ListDensity) => void;
  gridSize: GridSize;
  onGridSizeChange: (size: GridSize) => void;
  showThumbnails: boolean;
  onShowThumbnailsChange: (show: boolean) => void;
}

const DENSITY_LABELS: Record<ListDensity, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

const GRID_SIZE_LABELS: Record<GridSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/** The view mode, sort key, and sort direction radio groups: the "View"
 * dropdown's content on desktop, and the "View" submenu's content inside
 * the mobile "More" overflow menu. The grid offers an icon size where the
 * list and tree offer a row density. */
function ViewSortMenuItems({
  thumbnailsAvailable,
  viewMode,
  onViewModeChange,
  folderView,
  sortSpec,
  onSortSpecChange,
  folderSort,
  density,
  onDensityChange,
  gridSize,
  onGridSizeChange,
  showThumbnails,
  onShowThumbnailsChange,
}: ViewSortMenuItemsProps) {
  return (
    <>
      {folderView && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {folderView.pinned ? "Saved for this folder" : "Using default view"}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
      )}
      <DropdownMenuRadioGroup
        value={viewMode}
        onValueChange={(mode) => onViewModeChange(mode as ViewMode)}
      >
        <DropdownMenuRadioItem
          disabled={folderView?.disabled}
          value="list"
          closeOnClick
          className="whitespace-nowrap"
        >
          <ListIcon />
          List
          <DropdownMenuShortcut>⌘1</DropdownMenuShortcut>
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          disabled={folderView?.disabled}
          value="grid"
          closeOnClick
          className="whitespace-nowrap"
        >
          <LayoutGridIcon />
          Grid
          <DropdownMenuShortcut>⌘2</DropdownMenuShortcut>
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          disabled={folderView?.disabled}
          value="tree"
          closeOnClick
          className="whitespace-nowrap"
        >
          <ListTreeIcon />
          Tree
          <DropdownMenuShortcut>⌘3</DropdownMenuShortcut>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      {folderView && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={folderView.disabled} onClick={folderView.makeDefault}>
            Use as default for all folders
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={folderView.disabled || !folderView.pinned}
            onClick={folderView.useDefault}
          >
            Use default view
          </DropdownMenuItem>
          {folderView.error && (
            <DropdownMenuItem onClick={folderView.retry}>
              Retry loading folder view
            </DropdownMenuItem>
          )}
        </>
      )}
      {thumbnailsAvailable && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuCheckboxItem
              checked={showThumbnails}
              onCheckedChange={(checked) => onShowThumbnailsChange(checked)}
              className="flex flex-col items-start gap-0.5"
            >
              <span>Show thumbnails</span>
              <span className="font-normal text-muted-foreground text-xs">
                Preview images directly inside the list row
              </span>
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
        </>
      )}
      <DropdownMenuSeparator />
      {viewMode === "grid" ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Icon size</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={gridSize}
            onValueChange={(next) => onGridSizeChange(next as GridSize)}
          >
            {GRID_SIZES.map((value) => (
              <DropdownMenuRadioItem key={value} value={value} className="whitespace-nowrap">
                {GRID_SIZE_LABELS[value]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      ) : (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Density</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={density}
            onValueChange={(next) => onDensityChange(next as ListDensity)}
          >
            {LIST_DENSITIES.map((value) => (
              <DropdownMenuRadioItem key={value} value={value} className="whitespace-nowrap">
                {DENSITY_LABELS[value]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          {folderSort?.pinned ? "Sort by · saved for this folder" : "Sort by"}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sortSpec.key}
          onValueChange={(key) => onSortSpecChange({ ...sortSpec, key: key as SortKey })}
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <DropdownMenuRadioItem
              key={key}
              disabled={folderSort?.disabled}
              value={key}
              className="whitespace-nowrap"
            >
              {SORT_LABELS[key]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup
        value={sortSpec.direction}
        onValueChange={(direction) =>
          onSortSpecChange({ ...sortSpec, direction: direction as SortDirection })
        }
      >
        <DropdownMenuRadioItem
          disabled={folderSort?.disabled}
          value="asc"
          className="whitespace-nowrap"
        >
          Ascending
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          disabled={folderSort?.disabled}
          value="desc"
          className="whitespace-nowrap"
        >
          Descending
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      {folderSort && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={folderSort.disabled} onClick={folderSort.makeDefault}>
            Use as default sort for all folders
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={folderSort.disabled || !folderSort.pinned}
            onClick={folderSort.useDefault}
          >
            Use default sort
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

interface UploadMenuItemsProps {
  onUploadFiles: () => void;
  onUploadFolder: () => void;
}

/** "Upload files" and "Upload folder": the "Upload" dropdown's content on
 * desktop, and the "Upload" submenu's content inside the mobile "More"
 * overflow menu. */
function UploadMenuItems({ onUploadFiles, onUploadFolder }: UploadMenuItemsProps) {
  return (
    <>
      <DropdownMenuItem className="whitespace-nowrap" onClick={onUploadFiles}>
        <FilePlusIcon />
        Upload files
      </DropdownMenuItem>
      <DropdownMenuItem className="whitespace-nowrap" onClick={onUploadFolder}>
        <FolderUpIcon />
        Upload folder
      </DropdownMenuItem>
    </>
  );
}

/** 44x44 minimum tap target for a toolbar trigger below `md`, without
 * affecting the desktop layout. */
const MOBILE_TAP_TARGET = "max-md:size-11 max-md:justify-center max-md:px-0";

/**
 * View toggle, sort menu, new folder, upload menu, selection actions, and
 * the inspector toggle. Below `md` (see `toolbarVisibility`), only New
 * stays inline; every other action moves into a "More" overflow menu whose
 * trigger carries the selection count as a badge, so the header never
 * overflows horizontally on narrow screens. Desktop is unchanged.
 */
export function FilesToolbarActions({
  viewMode,
  onViewModeChange,
  folderView,
  sortSpec,
  onSortSpecChange,
  folderSort,
  density,
  onDensityChange,
  gridSize,
  onGridSizeChange,
  onNewFolder,
  onNewFile,
  onNewOfficeDocument,
  onUploadFiles,
  onUploadFolder,
  detailsOpen,
  onToggleDetails,
  selection,
  capabilities = DEFAULT_CAPABILITIES,
  onClearSelection,
  onDuplicateSelection,
  onCompressSelection,
  onOrganizeSelection,
  onAddSelectionToChat,
  onDownloadSelection,
  showThumbnails,
  onShowThumbnailsChange,
  writeBlock = null,
}: FilesToolbarActionsProps) {
  const blocked = writeBlock !== null;
  const isMobile = useIsMobile();
  const { inline, overflow } = toolbarVisibility(isMobile);
  const inOverflow = overflow.length > 0;
  const selectedCount = selection.files + selection.folders;
  const downloadAvailable = canDownload(capabilities, selection);
  const newOfficeDocument = capabilities.office ? onNewOfficeDocument : undefined;
  const ViewIcon = VIEW_MODE_ICONS[viewMode];
  const detailsLabel = detailsOpen ? "Hide details" : "Show details";

  return (
    <div className="flex items-center gap-1.5">
      {!inOverflow && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" title="View" />}>
            <ViewIcon />
            <span className="max-[899px]:hidden">View</span>
            <ChevronDownIcon className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <ViewSortMenuItems
              thumbnailsAvailable={capabilities.index}
              viewMode={viewMode}
              onViewModeChange={onViewModeChange}
              folderView={folderView}
              sortSpec={sortSpec}
              onSortSpecChange={onSortSpecChange}
              folderSort={folderSort}
              density={density}
              onDensityChange={onDensityChange}
              gridSize={gridSize}
              onGridSizeChange={onGridSizeChange}
              showThumbnails={showThumbnails}
              onShowThumbnailsChange={onShowThumbnailsChange}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              title={writeBlock ?? "New"}
              disabled={blocked}
              className={MOBILE_TAP_TARGET}
            />
          }
        >
          <PlusIcon />
          <span className="max-[899px]:hidden">New</span>
          <ChevronDownIcon className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem className="whitespace-nowrap" onClick={onNewFolder}>
            <FolderPlusIcon />
            New folder
            <DropdownMenuShortcut>⌘⇧N</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="whitespace-nowrap" onClick={() => onNewFile("text")}>
            <FileTextIcon />
            Text file
          </DropdownMenuItem>
          <DropdownMenuItem className="whitespace-nowrap" onClick={() => onNewFile("markdown")}>
            <FileCodeIcon />
            Markdown file
          </DropdownMenuItem>
          {newOfficeDocument && (
            <>
              <DropdownMenuSeparator />
              {(["document", "spreadsheet", "presentation"] as const).map((kind) => (
                <DropdownMenuItem key={kind} onClick={() => newOfficeDocument(kind)}>
                  <FileTextIcon />
                  {OFFICE_DOCUMENT_LABELS[kind]}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {!inOverflow && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" title={writeBlock ?? "Upload"} disabled={blocked} />
            }
          >
            <UploadIcon />
            <span className="max-[899px]:hidden">Upload</span>
            <ChevronDownIcon className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <UploadMenuItems onUploadFiles={onUploadFiles} onUploadFolder={onUploadFolder} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {!inOverflow && selectedCount > 0 && (
        <div className="flex items-center gap-1 rounded-md bg-muted py-1 pr-1 pl-2 text-muted-foreground text-xs">
          <span className="tabular-nums">{selectedCount} selected</span>
          {onOrganizeSelection !== undefined && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Organize"
                    onClick={onOrganizeSelection}
                  />
                }
              >
                <SparklesIcon />
              </TooltipTrigger>
              <TooltipContent>Organize</TooltipContent>
            </Tooltip>
          )}
          {onAddSelectionToChat !== undefined && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Add to chat"
                    onClick={onAddSelectionToChat}
                  />
                }
              >
                <MessageSquarePlusIcon />
              </TooltipTrigger>
              <TooltipContent>Add to chat</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={selectedCount !== 1 || blocked}
                  aria-label="Duplicate"
                  onClick={onDuplicateSelection}
                />
              }
            >
              <CopyIcon />
            </TooltipTrigger>
            <TooltipContent>Duplicate</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Compress"
                  onClick={onCompressSelection}
                />
              }
            >
              <FileArchiveIcon />
            </TooltipTrigger>
            <TooltipContent>Compress</TooltipContent>
          </Tooltip>
          {inline.includes("download") && downloadAvailable && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Download"
                    onClick={onDownloadSelection}
                  />
                }
              >
                <DownloadIcon />
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear selection"
            onClick={onClearSelection}
          >
            <XIcon />
          </Button>
        </div>
      )}

      {!inOverflow && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={detailsOpen ? "secondary" : "ghost"}
                size="icon-sm"
                aria-pressed={detailsOpen}
                onClick={onToggleDetails}
              />
            }
          >
            <PanelRightIcon />
            <span className="sr-only">Toggle details</span>
          </TooltipTrigger>
          <TooltipContent>Details</TooltipContent>
        </Tooltip>
      )}

      {inOverflow && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className={cn(MOBILE_TAP_TARGET, "relative")} />
            }
          >
            <MoreHorizontalIcon />
            <span className="sr-only">More</span>
            {selectedCount > 0 && (
              <Badge aria-hidden="true" variant="secondary" className="ml-0.5">
                {selectedCount}
              </Badge>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            {selectedCount > 0 && (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{selectedCount} selected</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ViewIcon />
                View
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <ViewSortMenuItems
                  thumbnailsAvailable={capabilities.index}
                  viewMode={viewMode}
                  onViewModeChange={onViewModeChange}
                  folderView={folderView}
                  sortSpec={sortSpec}
                  onSortSpecChange={onSortSpecChange}
                  folderSort={folderSort}
                  density={density}
                  onDensityChange={onDensityChange}
                  gridSize={gridSize}
                  onGridSizeChange={onGridSizeChange}
                  showThumbnails={showThumbnails}
                  onShowThumbnailsChange={onShowThumbnailsChange}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={blocked}>
                <UploadIcon />
                Upload
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <UploadMenuItems onUploadFiles={onUploadFiles} onUploadFolder={onUploadFolder} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={selectedCount !== 1 || blocked}
              onClick={onDuplicateSelection}
            >
              <CopyIcon />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem disabled={selectedCount === 0} onClick={onCompressSelection}>
              <FileArchiveIcon />
              Compress
            </DropdownMenuItem>
            {onOrganizeSelection !== undefined && (
              <DropdownMenuItem disabled={selectedCount === 0} onClick={onOrganizeSelection}>
                <SparklesIcon />
                Organize
              </DropdownMenuItem>
            )}
            {onAddSelectionToChat !== undefined && (
              <DropdownMenuItem disabled={selectedCount === 0} onClick={onAddSelectionToChat}>
                <MessageSquarePlusIcon />
                Add to chat
              </DropdownMenuItem>
            )}
            {overflow.includes("download") && downloadAvailable && (
              <DropdownMenuItem disabled={selectedCount === 0} onClick={onDownloadSelection}>
                <DownloadIcon />
                Download
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onToggleDetails}>
              <PanelRightIcon />
              {detailsLabel}
            </DropdownMenuItem>
            {selectedCount > 0 && (
              <DropdownMenuItem onClick={onClearSelection}>
                <XIcon />
                Clear selection
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
