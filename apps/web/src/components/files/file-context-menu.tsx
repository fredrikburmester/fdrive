"use client";

import type { FsEntry } from "@fdrive/contracts";
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderInputIcon,
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

export type RowContextAction = "open" | "download" | "rename" | "moveTo" | "copyTo" | "delete";

export interface FileContextMenuProps {
  entry: FsEntry;
  children: ReactNode;
  onAction: (action: RowContextAction, entry: FsEntry) => void;
}

/** The right-click menu shared by list rows and grid tiles. */
export function FileContextMenu({ entry, children, onAction }: FileContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onAction("open", entry)}>
          <ExternalLinkIcon />
          Open
        </ContextMenuItem>
        {entry.kind !== "dir" && (
          <ContextMenuItem onClick={() => onAction("download", entry)}>
            <DownloadIcon />
            Download
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onAction("rename", entry)}>
          <PencilIcon />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("moveTo", entry)}>
          <FolderInputIcon />
          Move to...
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("copyTo", entry)}>
          <CopyIcon />
          Copy to...
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onAction("delete", entry)}>
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
