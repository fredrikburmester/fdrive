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
  MoreHorizontalIcon,
  PanelRightIcon,
  PlusIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { DragEvent } from "react";
import { useState } from "react";
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
import { breadcrumbLayout } from "@/lib/files/breadcrumb-layout";
import { dropTargetState, effectFor } from "@/lib/files/dnd-targets";
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

/** The current folder's breadcrumb trail. Desktop collapses the middle when
 * long; below `md` it always truncates from the left instead, keeping only
 * the current folder inline so it is never pushed off narrow screens (see
 * `breadcrumbLayout`). */
export function FilesBreadcrumb({ path, onInternalDrop }: FilesBreadcrumbProps) {
  const isMobile = useIsMobile();
  const crumbs = buildBreadcrumbs(path);
  const layout = breadcrumbLayout(crumbs, isMobile);

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="min-w-0 flex-nowrap">
        {layout.head.map((crumb, index) => (
          <CrumbRow
            key={crumb.path}
            crumb={crumb}
            isLast={!layout.collapsed && index === layout.head.length - 1}
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
                onInternalDrop={onInternalDrop}
              />
            ))}
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

interface CrumbRowProps {
  crumb: BreadcrumbEntry;
  isLast: boolean;
  onInternalDrop?:
    | ((paths: string[], targetPath: string, effect: "move" | "copy") => void)
    | undefined;
}

/** One breadcrumb segment, including Home; every segment (even the current,
 * non-linked one) accepts an internal drag-and-drop, so dropping a file onto
 * an ancestor moves it up out of the current folder, matching Finder's path
 * bar. */
function CrumbRow({ crumb, isLast, onInternalDrop }: CrumbRowProps) {
  const [isDropTarget, setIsDropTarget] = useState(false);

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
            className="max-w-48 truncate rounded-sm px-1 data-[drop-target=true]:bg-primary/5 data-[drop-target=true]:ring-2 data-[drop-target=true]:ring-primary/50"
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
            className={cn(
              "max-w-48 truncate rounded-sm px-1",
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
  /** Downloads the currently selected entries (single direct download or zip). */
  onDownloadSelection: () => void;
  /** Whether image thumbnails are shown in list view. */
  showThumbnails: boolean;
  /** Toggles the show-thumbnails preference for list view. */
  onShowThumbnailsChange: (show: boolean) => void;
}

interface ViewSortMenuItemsProps {
  /** Whether the login's provider is indexed, so thumbnails can exist at all. */
  thumbnailsAvailable: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  folderView?: FolderViewActions | undefined;
  sortSpec: SortSpec;
  onSortSpecChange: (spec: SortSpec) => void;
  showThumbnails: boolean;
  onShowThumbnailsChange: (show: boolean) => void;
}

/** The view mode, sort key, and sort direction radio groups: the "View"
 * dropdown's content on desktop, and the "View" submenu's content inside
 * the mobile "More" overflow menu. */
function ViewSortMenuItems({
  thumbnailsAvailable,
  viewMode,
  onViewModeChange,
  folderView,
  sortSpec,
  onSortSpecChange,
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
      <DropdownMenuGroup>
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sortSpec.key}
          onValueChange={(key) => onSortSpecChange({ ...sortSpec, key: key as SortKey })}
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <DropdownMenuRadioItem key={key} value={key} className="whitespace-nowrap">
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
        <DropdownMenuRadioItem value="asc" className="whitespace-nowrap">
          Ascending
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="desc" className="whitespace-nowrap">
          Descending
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
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
  onDownloadSelection,
  showThumbnails,
  onShowThumbnailsChange,
}: FilesToolbarActionsProps) {
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
              showThumbnails={showThumbnails}
              onShowThumbnailsChange={onShowThumbnailsChange}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" title="New" className={MOBILE_TAP_TARGET} />}
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
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" title="Upload" />}>
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={selectedCount !== 1}
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
                  showThumbnails={showThumbnails}
                  onShowThumbnailsChange={onShowThumbnailsChange}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <UploadIcon />
                Upload
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <UploadMenuItems onUploadFiles={onUploadFiles} onUploadFolder={onUploadFolder} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={selectedCount !== 1} onClick={onDuplicateSelection}>
              <CopyIcon />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem disabled={selectedCount === 0} onClick={onCompressSelection}>
              <FileArchiveIcon />
              Compress
            </DropdownMenuItem>
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
