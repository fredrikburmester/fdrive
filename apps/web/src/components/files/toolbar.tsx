"use client";

import type { SortKey } from "@fdrive/core";
import {
  ArrowDownWideNarrowIcon,
  ArrowUpNarrowWideIcon,
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
  UploadIcon,
  XIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
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
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { NewFileKind } from "@/lib/editor/new-file";
import { type BreadcrumbEntry, buildBreadcrumbs } from "@/lib/files/path-url";
import type { SortSpec } from "@/lib/files/sorting";
import type { ViewMode } from "@/lib/files/view-mode";

const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  size: "Size",
  modifiedAt: "Date modified",
  ext: "Kind",
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
}

/** The current folder's breadcrumb trail, collapsing the middle when long. */
export function FilesBreadcrumb({ path }: FilesBreadcrumbProps) {
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
    <Breadcrumb>
      <BreadcrumbList className="flex-nowrap">
        {visible.head.map((crumb, index) => (
          <CrumbRow
            key={crumb.path}
            crumb={crumb}
            isLast={!shouldCollapse && index === visible.head.length - 1}
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
              <CrumbRow key={crumb.path} crumb={crumb} isLast={index === visible.tail.length - 1} />
            ))}
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function CrumbRow({ crumb, isLast }: { crumb: BreadcrumbEntry; isLast: boolean }) {
  return (
    <>
      <BreadcrumbItem>
        {isLast ? (
          <BreadcrumbPage className="truncate">{crumb.name}</BreadcrumbPage>
        ) : (
          <BreadcrumbLink render={<Link href={toRoute(crumb.href)} />} className="truncate">
            {crumb.name}
          </BreadcrumbLink>
        )}
      </BreadcrumbItem>
      {!isLast && <BreadcrumbSeparator />}
    </>
  );
}

export interface FilesToolbarActionsProps {
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
  onUploadFiles,
  onUploadFolder,
  detailsOpen,
  onToggleDetails,
  selectedCount,
  onClearSelection,
  onDuplicateSelection,
  onCompressSelection,
}: FilesToolbarActionsProps) {
  return (
    <div className="flex items-center gap-1.5">
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

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" title={`Sort by ${SORT_LABELS[sortSpec.key]}`} />
          }
        >
          {sortSpec.direction === "asc" ? <ArrowUpNarrowWideIcon /> : <ArrowDownWideNarrowIcon />}
          <span className="max-[899px]:hidden">{SORT_LABELS[sortSpec.key]}</span>
          <ChevronDownIcon className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
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
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            className="whitespace-nowrap"
            checked={sortSpec.direction === "desc"}
            onCheckedChange={(checked) =>
              onSortSpecChange({ ...sortSpec, direction: checked ? "desc" : "asc" })
            }
          >
            Descending
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ToggleGroup
        value={[viewMode]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "list" || next === "grid" || next === "tree") {
            onViewModeChange(next);
          }
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="list" aria-label="List view">
          <ListIcon />
        </ToggleGroupItem>
        <ToggleGroupItem value="grid" aria-label="Grid view">
          <LayoutGridIcon />
        </ToggleGroupItem>
        <ToggleGroupItem value="tree" aria-label="Tree view">
          <ListTreeIcon />
        </ToggleGroupItem>
      </ToggleGroup>

      <Button variant="ghost" size="sm" title="New folder" onClick={onNewFolder}>
        <FolderPlusIcon />
        <span className="max-[899px]:hidden">New folder</span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" title="New file" />}>
          <FilePlusIcon />
          <span className="max-[899px]:hidden">New file</span>
          <ChevronDownIcon className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem className="whitespace-nowrap" onClick={() => onNewFile("text")}>
            <FileTextIcon />
            Text file
          </DropdownMenuItem>
          <DropdownMenuItem className="whitespace-nowrap" onClick={() => onNewFile("markdown")}>
            <FileCodeIcon />
            Markdown file
          </DropdownMenuItem>
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
