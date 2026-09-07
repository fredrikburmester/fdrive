"use client";

import type { FsEntry, OfficeStatusResponse, Tag } from "@fdrive/contracts";
import { detectArchiveKind } from "@fdrive/core";
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FilesIcon,
  FolderInputIcon,
  FolderSearchIcon,
  Link2Icon,
  PackageOpenIcon,
  PencilIcon,
  StarIcon,
  StarOffIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { tagDotClassName } from "@/lib/metadata/colors";
import type { TagCheckState } from "@/lib/metadata/tag-set";
import { OFFICE_MODE_LABELS, officeModesFor } from "@/lib/office/capabilities";
import { cn } from "@/lib/utils";

export type RowContextAction =
  | "office:view"
  | "office:edit"
  | "office:convert"
  | "share"
  | "open"
  | "revealInFolder"
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
  officeStatus?: OfficeStatusResponse | undefined;
  entry: FsEntry;
  children: ReactNode;
  onAction: (action: RowContextAction, entry: FsEntry) => void;
  /**
   * How many entries this menu's actions would apply to: the whole
   * selection's size when `entry` is part of a multi-entry selection, else
   * 1. Defaults to 1 (acting on just this entry). Disables "Duplicate" and
   * hides "Extract here"/"Extract to" for a multi-entry selection, since
   * both only ever make sense for a single entry.
   */
  selectionCount?: number;
  /**
   * Whether the group of entries this menu's download action would apply to
   * (see `selectionCount`) includes at least one folder. Folders have no
   * direct download of their own, so the download item reads "Download as
   * zip" and zips the group instead of streaming a single file. Defaults to
   * whether `entry` itself is a folder.
   */
  includesFolder?: boolean;
  /**
   * Hides "Move to" and "Copy to", for a read-only "virtual listing"
   * (favorites, recents, a tag's files) where the entries do not live in
   * one real folder, so moving or copying "into" the current view makes no
   * sense. Both items show by default.
   */
  hideMoveCopy?: boolean;
  /** Shows "Reveal in folder" above "Open", for a "virtual listing" whose
   * rows are not already inside the folder they live in (favorites,
   * recents, a tag's files). Hidden by default, since the plain file
   * browser is already showing the row's own folder. */
  showReveal?: boolean;
  /** Hides "Compress" and "Extract", for a "virtual listing" that does
   * not run the archive jobs (favorites, recents, a tag's files). Both show
   * by default. */
  hideArchive?: boolean;
  /** Every tag known to the account, for the "Tags" submenu. Defaults to
   * none, so a caller that has not wired up tags yet still renders. */
  tags?: readonly Tag[];
  /** The check state of `tagId` across the group of entries this menu's
   * actions apply to (see `selectionCount`), for that tag's checkbox.
   * Defaults to always "unchecked". */
  tagCheckState?: (tagId: string) => TagCheckState;
  /** Adds or removes `tagId` on every entry in the group. Defaults to a no-op. */
  onToggleTag?: (tagId: string, checked: boolean) => void;
  /** Opens the full `TagPicker` (as a dialog, since a context menu closes
   * before a popover anchored to it could stay open). Defaults to a no-op. */
  onOpenTagsEditor?: () => void;
  /** Whether every entry in the group is already a favorite. Defaults to `false`. */
  favorite?: boolean;
  /** Favorites (or unfavorites) every entry in the group. Defaults to a no-op. */
  onToggleFavorite?: (next: boolean) => void;
  /** Whether the active identity's storage provider exposes a trash: when
   * true, the last item reads "Move to Trash" instead of "Delete" (the
   * icon stays the same either way). Defaults to `false`. */
  trashAvailable?: boolean;
}

const DEFAULT_TAGS: readonly Tag[] = [];
const DEFAULT_TAG_CHECK_STATE = (): TagCheckState => "unchecked";
const DEFAULT_NO_OP = () => {};

/** The right-click menu shared by list rows and grid tiles. */
export function FileContextMenu({
  entry,
  officeStatus,
  children,
  onAction,
  selectionCount = 1,
  includesFolder = entry.kind === "dir",
  hideMoveCopy = false,
  showReveal = false,
  hideArchive = false,
  tags = DEFAULT_TAGS,
  tagCheckState = DEFAULT_TAG_CHECK_STATE,
  onToggleTag = DEFAULT_NO_OP,
  onOpenTagsEditor = DEFAULT_NO_OP,
  favorite = false,
  onToggleFavorite = DEFAULT_NO_OP,
  trashAvailable = false,
}: FileContextMenuProps) {
  const isMultiSelection = selectionCount > 1;
  const archiveKind = entry.kind !== "dir" ? detectArchiveKind(entry.name) : null;
  const canExtract = !isMultiSelection && archiveKind !== null;

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onAction("share", entry)}>
          <Link2Icon />
          Share
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("open", entry)}>
          <ExternalLinkIcon />
          Open
        </ContextMenuItem>
        {officeModesFor(entry, officeStatus, selectionCount).map((mode) => (
          <ContextMenuItem key={mode} onClick={() => onAction(`office:${mode}`, entry)}>
            <ExternalLinkIcon />
            {OFFICE_MODE_LABELS[mode]}
          </ContextMenuItem>
        ))}
        {showReveal && (
          <ContextMenuItem onClick={() => onAction("revealInFolder", entry)}>
            <FolderSearchIcon />
            Reveal in folder
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={isMultiSelection} onClick={() => onAction("duplicate", entry)}>
          <CopyIcon />
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("rename", entry)}>
          <PencilIcon />
          Rename
        </ContextMenuItem>
        {!hideMoveCopy && (
          <>
            <ContextMenuItem onClick={() => onAction("moveTo", entry)}>
              <FolderInputIcon />
              Move to
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onAction("copyTo", entry)}>
              <FilesIcon />
              Copy to
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <TagIcon />
            Tags
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            {tags.length === 0 ? (
              <ContextMenuItem disabled>No tags yet</ContextMenuItem>
            ) : (
              tags.map((tag) => {
                const state = tagCheckState(tag.id);
                return (
                  <ContextMenuCheckboxItem
                    key={tag.id}
                    checked={state === "checked"}
                    onCheckedChange={(checked) => onToggleTag(tag.id, checked)}
                  >
                    <span
                      className={cn("size-2 shrink-0 rounded-full", tagDotClassName(tag.color))}
                    />
                    <span className="flex-1 truncate">{tag.name}</span>
                    {state === "indeterminate" && (
                      <span className="text-[10px] text-muted-foreground">mixed</span>
                    )}
                  </ContextMenuCheckboxItem>
                );
              })
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onOpenTagsEditor}>
              <PencilIcon />
              Edit tags
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => onToggleFavorite(!favorite)}>
          {favorite ? <StarOffIcon /> : <StarIcon />}
          {favorite ? "Remove from Favorites" : "Add to Favorites"}
        </ContextMenuItem>
        {!hideArchive && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onAction("compress", entry)}>
              <FileArchiveIcon />
              Compress
            </ContextMenuItem>
            {canExtract && (
              <>
                <ContextMenuItem onClick={() => onAction("extractHere", entry)}>
                  <PackageOpenIcon />
                  Extract here
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onAction("extractTo", entry)}>
                  <PackageOpenIcon />
                  Extract to
                </ContextMenuItem>
              </>
            )}
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onAction("download", entry)}>
          <DownloadIcon />
          {includesFolder ? "Download as zip" : "Download"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant={trashAvailable ? "default" : "destructive"}
          onClick={() => onAction("delete", entry)}
        >
          <Trash2Icon />
          {trashAvailable ? "Move to Trash" : "Delete"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
