"use client";

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
import { buildBreadcrumbs } from "@/lib/files/path-url";
import { useListing } from "@/lib/files/queries";
import { FileIcon } from "./file-icon";

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
  onOpenChange: (open: boolean) => void;
  onConfirm: (destination: string) => void;
  pending?: boolean;
}

/**
 * A dialog for choosing a destination folder: a breadcrumb for the current
 * location and a navigable list of its subfolders, ending in a "Move here"
 * or "Copy here" action.
 */
export function DestinationPicker({
  open,
  mode,
  initialPath = "/",
  onOpenChange,
  onConfirm,
  pending = false,
}: DestinationPickerProps) {
  const [path, setPath] = useState(initialPath);
  const { data, isLoading } = useListing(path);
  const folders = (data?.entries ?? []).filter((entry) => entry.kind === "dir");
  const crumbs = buildBreadcrumbs(path);
  const labels = LABELS[mode];

  function handleOpenChange(next: boolean) {
    if (next) {
      setPath(initialPath);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>Choose a destination folder.</DialogDescription>
        </DialogHeader>

        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              <BreadcrumbCrumb
                key={crumb.path}
                name={crumb.name}
                isCurrent={index === crumbs.length - 1}
                onClick={() => setPath(crumb.path)}
              />
            ))}
          </BreadcrumbList>
        </Breadcrumb>

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
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
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
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={pending} onClick={() => onConfirm(path)}>
            {labels.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BreadcrumbCrumbProps {
  name: string;
  isCurrent: boolean;
  onClick: () => void;
}

function BreadcrumbCrumb({ name, isCurrent, onClick }: BreadcrumbCrumbProps) {
  return (
    <>
      <BreadcrumbItem>
        {isCurrent ? (
          <BreadcrumbPage>{name}</BreadcrumbPage>
        ) : (
          <BreadcrumbLink render={<button type="button" onClick={onClick} />}>
            {name}
          </BreadcrumbLink>
        )}
      </BreadcrumbItem>
      {!isCurrent && <BreadcrumbSeparator />}
    </>
  );
}
