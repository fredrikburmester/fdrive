"use client";

import { isWithin, joinPath } from "@fdrive/core";
import { FolderPlusIcon } from "lucide-react";
import { useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { movablePaths } from "@/lib/files/move-guard";
import { buildBreadcrumbs } from "@/lib/files/path-url";
import { useListing, useMkdir } from "@/lib/files/queries";
import { FileIcon } from "./file-icon";
import { NewFolderDialog } from "./new-folder-dialog";

export type DestinationPickerMode =
  | "move"
  | "copy"
  | "compressDestination"
  | "extractTo"
  | "restoreTo";

interface DestinationPickerLabels {
  readonly title: string;
  readonly confirmLabel: string;
}

const LABELS: Record<DestinationPickerMode, DestinationPickerLabels> = {
  move: { title: "Move to", confirmLabel: "Move here" },
  copy: { title: "Copy to", confirmLabel: "Copy here" },
  compressDestination: { title: "Choose destination", confirmLabel: "Choose" },
  extractTo: { title: "Extract to", confirmLabel: "Extract here" },
  restoreTo: { title: "Restore to", confirmLabel: "Restore here" },
};

export interface DestinationPickerProps {
  open: boolean;
  mode: DestinationPickerMode;
  initialPath?: string;
  /** Move/copy sources whose subtrees cannot be destinations. */
  sourcePaths?: readonly string[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (destination: string) => void;
  pending?: boolean;
  /** A caution shown under the description, e.g. that this provider moves a folder by copying it. */
  warning?: string | null;
}

/**
 * A dialog for choosing a destination folder: a breadcrumb for the current
 * location and a navigable list of its subfolders, ending in a "Move here"
 * or "Copy here" action.
 */
export function DestinationPicker(props: DestinationPickerProps) {
  // A fresh browsing session on each open, including callers that stay mounted.
  return props.open ? <DestinationPickerContent {...props} /> : null;
}

function DestinationPickerContent({
  open,
  mode,
  initialPath = "/",
  sourcePaths = [],
  onOpenChange,
  onConfirm,
  pending = false,
  warning = null,
}: DestinationPickerProps) {
  const [path, setPath] = useState(initialPath);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const mkdir = useMkdir();
  const busy = pending || mkdir.isPending;
  const { data, isLoading } = useListing(path);
  const folders = (data?.entries ?? []).filter(
    (entry) => entry.kind === "dir" && !sourcePaths.some((source) => isWithin(source, entry.path)),
  );
  const canConfirm = movablePaths(sourcePaths, path).length === sourcePaths.length;
  const canCreate = !sourcePaths.some((source) => isWithin(source, path));
  const crumbs = buildBreadcrumbs(path);
  const labels = LABELS[mode];

  function handleOpenChange(next: boolean) {
    if (busy) return;
    onOpenChange(next);
  }

  function handleCreateFolder(name: string) {
    if (busy || !canCreate) return;
    mkdir.mutate(joinPath(path, name), {
      onSuccess: (entry) => {
        setPath(entry.path);
        setNewFolderOpen(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-cols-1 overflow-y-auto sm:max-w-md"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>Choose a destination folder.</DialogDescription>
          {warning !== null && <p className="text-sm text-muted-foreground">{warning}</p>}
        </DialogHeader>

        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList>
              {crumbs.map((crumb, index) => (
                <BreadcrumbCrumb
                  key={crumb.path}
                  name={crumb.name}
                  isCurrent={index === crumbs.length - 1}
                  disabled={busy}
                  onClick={() => setPath(crumb.path)}
                />
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 shrink-0 sm:h-8"
            disabled={busy || !canCreate}
            onClick={() => setNewFolderOpen(true)}
          >
            <FolderPlusIcon data-icon="inline-start" />
            New folder
          </Button>
        </div>

        <ScrollArea className="h-64 rounded-md border border-border">
          <ul className="flex flex-col gap-0.5 p-1">
            {isLoading && <li className="px-3 py-2 text-muted-foreground text-sm">Loading…</li>}
            {!isLoading && folders.length === 0 && (
              <li className="px-3 py-2 text-muted-foreground text-sm">No subfolders</li>
            )}
            {folders.map((folder) => (
              <li key={folder.path}>
                <button
                  type="button"
                  disabled={busy}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:min-h-0"
                  onClick={() => setPath(folder.path)}
                >
                  <FileIcon kind={folder.kind} ext={folder.ext} mime={folder.mime} />
                  <span className="truncate">{folder.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-8"
            disabled={busy}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="h-11 sm:h-8"
            disabled={busy || newFolderOpen || !canConfirm}
            onClick={() => onConfirm(path)}
          >
            {labels.confirmLabel}
          </Button>
        </DialogFooter>
        <NewFolderDialog
          open={newFolderOpen}
          onOpenChange={setNewFolderOpen}
          onCreate={handleCreateFolder}
          pending={mkdir.isPending}
        />
      </DialogContent>
    </Dialog>
  );
}

interface BreadcrumbCrumbProps {
  name: string;
  isCurrent: boolean;
  disabled: boolean;
  onClick: () => void;
}

function BreadcrumbCrumb({ name, isCurrent, disabled, onClick }: BreadcrumbCrumbProps) {
  return (
    <>
      <BreadcrumbItem className="min-w-0 max-w-full">
        {isCurrent ? (
          <BreadcrumbPage className="truncate" title={name}>
            {name}
          </BreadcrumbPage>
        ) : (
          <BreadcrumbLink
            render={
              <button
                type="button"
                disabled={disabled}
                onClick={onClick}
                className="min-h-11 min-w-0 max-w-full truncate text-left sm:min-h-0"
                title={name}
              />
            }
          >
            {name}
          </BreadcrumbLink>
        )}
      </BreadcrumbItem>
      {!isCurrent && <BreadcrumbSeparator />}
    </>
  );
}
