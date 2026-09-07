"use client";

import type { SortDirection, SortKey } from "@fdrive/core";
import {
  ChevronDownIcon,
  CopyIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderPlusIcon,
  FolderUpIcon,
  LayoutGridIcon,
  ListIcon,
  ListTreeIcon,
  PanelRightIcon,
  PlusIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { DragEvent } from "react";
import { useState } from "react";
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
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getActiveDragPaths, INTERNAL_DND_TYPE, readDraggedPaths } from "@/lib/dnd";
import type { NewFileKind } from "@/lib/editor/new-file";
import { dropTargetState, effectFor } from "@/lib/files/dnd-targets";
import { type BreadcrumbEntry, buildBreadcrumbs } from "@/lib/files/path-url";
import type { SortSpec } from "@/lib/files/sorting";
import type { ViewMode } from "@/lib/files/view-mode";
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

const COLLAPSE_THRESHOLD = 4;

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

/** The current folder's breadcrumb trail, collapsing the middle when long. */
export function FilesBreadcrumb({ path, onInternalDrop }: FilesBreadcrumbProps) {
  const crumbs = buildBreadcrumbs(path);
  const shouldCollapse = crumbs.length > COLLAPSE_THRESHOLD;
  const visible = shouldCollapse
    ? {
        head: [crumbs[0] as BreadcrumbEntry],
        hidden: crumbs.slice(1, -2),
        tail: crumbs.slice(-2),
      }
    : { head: crumbs, hidden: [] as BreadcrumbEntry[], tail: [] as BreadcrumbEntry[] };

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="min-w-0 flex-nowrap">
        {visible.head.map((crumb, index) => (
          <CrumbRow
            key={crumb.path}
            crumb={crumb}
            isLast={!shouldCollapse && index === visible.head.length - 1}
            onInternalDrop={onInternalDrop}
          />
        ))}
        {shouldCollapse && (
          <>
            <BreadcrumbItem>
              <DropdownMenu>
                <DropdownMenuTrigger>
                  <BreadcrumbEllipsis className="cursor-pointer hover:bg-muted hover:text-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {visible.hidden.map((crumb) => (
                    <DropdownMenuItem key={crumb.path} render={<Link href={toRoute(crumb.href)} />}>
                      {crumb.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            {visible.tail.map((crumb, index) => (
              <CrumbRow
                key={crumb.path}
                crumb={crumb}
                isLast={index === visible.tail.length - 1}
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

export interface FilesToolbarActionsProps {
  onNewOfficeDocument?: ((kind: OfficeDocumentKind) => void) | undefined;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  sortSpec: SortSpec;
  onSortSpecChange: (spec: SortSpec) => void;
  onNewFolder: () => void;
  onNewFile: (kind: NewFileKind) => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** Number of currently selected rows; shows an "N selected" pill when > 0. */
  selectedCount: number;
  onClearSelection: () => void;
  /** Duplicates the single selected entry. Only enabled for a one-entry selection. */
  onDuplicateSelection: () => void;
  /** Opens the compress dialog for the current selection (any size). */
  onCompressSelection: () => void;
}

/** View toggle, sort menu, new folder, upload menu, and the inspector toggle. */
export function FilesToolbarActions({
  viewMode,
  onViewModeChange,
  sortSpec,
  onSortSpecChange,
  onNewFolder,
  onNewFile,
  onNewOfficeDocument,
  onUploadFiles,
  onUploadFolder,
  detailsOpen,
  onToggleDetails,
  selectedCount,
  onClearSelection,
  onDuplicateSelection,
  onCompressSelection,
}: FilesToolbarActionsProps) {
  const ViewIcon = VIEW_MODE_ICONS[viewMode];

  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" title="View" />}>
          <ViewIcon />
          <span className="max-[899px]:hidden">View</span>
          <ChevronDownIcon className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <DropdownMenuRadioGroup
            value={viewMode}
            onValueChange={(mode) => onViewModeChange(mode as ViewMode)}
          >
            <DropdownMenuRadioItem value="list" closeOnClick className="whitespace-nowrap">
              <ListIcon />
              List
              <DropdownMenuShortcut>⌘1</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="grid" closeOnClick className="whitespace-nowrap">
              <LayoutGridIcon />
              Grid
              <DropdownMenuShortcut>⌘2</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="tree" closeOnClick className="whitespace-nowrap">
              <ListTreeIcon />
              Tree
              <DropdownMenuShortcut>⌘3</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
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
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" title="New" />}>
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
          {onNewOfficeDocument && (
            <>
              <DropdownMenuSeparator />
              {(["document", "spreadsheet", "presentation"] as const).map((kind) => (
                <DropdownMenuItem key={kind} onClick={() => onNewOfficeDocument(kind)}>
                  <FileTextIcon />
                  {OFFICE_DOCUMENT_LABELS[kind]}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" title="Upload" />}>
          <UploadIcon />
          <span className="max-[899px]:hidden">Upload</span>
          <ChevronDownIcon className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem className="whitespace-nowrap" onClick={onUploadFiles}>
            <FilePlusIcon />
            Upload files
          </DropdownMenuItem>
          <DropdownMenuItem className="whitespace-nowrap" onClick={onUploadFolder}>
            <FolderUpIcon />
            Upload folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {selectedCount > 0 && (
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
            <TooltipContent>Compress...</TooltipContent>
          </Tooltip>
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
    </div>
  );
}
