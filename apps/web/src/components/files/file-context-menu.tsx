"use client";

import type { FsEntry } from "@fdrive/contracts";
import { detectArchiveKind } from "@fdrive/core";
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FilesIcon,
  FolderInputIcon,
  PackageOpenIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export type RowContextAction =
  | "open"
  | "download"
  | "rename"
  | "moveTo"
  | "copyTo"
  | "delete"
  | "duplicate"
  | "compress"
  | "extractHere"
  | "extractTo";

export interface FileContextMenuProps {
  entry: FsEntry;
  children: ReactNode;
  onAction: (action: RowContextAction, entry: FsEntry) => void;
  /**
   * How many entries this menu's actions would apply to: the whole
   * selection's size when `entry` is part of a multi-entry selection, else
   * 1. Defaults to 1 (acting on just this entry). Disables "Duplicate" and
   * hides "Extract here"/"Extract to..." for a multi-entry selection, since
   * both only ever make sense for a single entry.
   */
  selectionCount?: number;
}

/** The right-click menu shared by list rows and grid tiles. */
export function FileContextMenu({
  entry,
  children,
  onAction,
  selectionCount = 1,
}: FileContextMenuProps) {
  const isMultiSelection = selectionCount > 1;
  const archiveKind = entry.kind !== "dir" ? detectArchiveKind(entry.name) : null;
  const canExtract = !isMultiSelection && archiveKind !== null;

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onAction("open", entry)}>
          <ExternalLinkIcon />
          Open
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={isMultiSelection} onClick={() => onAction("duplicate", entry)}>
          <CopyIcon />
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("rename", entry)}>
          <PencilIcon />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("moveTo", entry)}>
          <FolderInputIcon />
          Move to...
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("copyTo", entry)}>
          <FilesIcon />
          Copy to...
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onAction("compress", entry)}>
          <FileArchiveIcon />
          Compress...
        </ContextMenuItem>
        {canExtract && (
          <>
            <ContextMenuItem onClick={() => onAction("extractHere", entry)}>
              <PackageOpenIcon />
              Extract here
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onAction("extractTo", entry)}>
              <PackageOpenIcon />
              Extract to...
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        {entry.kind !== "dir" && (
          <>
            <ContextMenuItem onClick={() => onAction("download", entry)}>
              <DownloadIcon />
              Download
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem variant="destructive" onClick={() => onAction("delete", entry)}>
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
