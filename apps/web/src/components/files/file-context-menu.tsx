"use client";

import type { FsEntry, OfficeStatusResponse, ReceivedGrant, Tag } from "@fdrive/contracts";
import { detectArchiveKind } from "@fdrive/core";
import {
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FilesIcon,
  FolderInputIcon,
  FolderSearchIcon,
  Link2Icon,
  LogOutIcon,
  MessageSquarePlusIcon,
  PackageOpenIcon,
  PencilIcon,
  SparklesIcon,
  StarIcon,
  StarOffIcon,
  TagIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import type { ComponentType, MouseEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type BrowserSelection, selectionOf } from "@/lib/files/selection";
import { entryRestrictions } from "@/lib/grants/paths";
import { tagDotClassName } from "@/lib/metadata/colors";
import type { TagCheckState } from "@/lib/metadata/tag-set";
import { OFFICE_MODE_LABELS, officeModesFor } from "@/lib/office/capabilities";
import { cn } from "@/lib/utils";

export type RowContextAction =
  | "office:view"
  | "office:edit"
  | "office:convert"
  | "share"
  | "shareWithPeople"
  | "leave"
  | "open"
  | "revealInFolder"
  | "download"
  | "rename"
  | "moveTo"
  | "copyTo"
  | "organize"
  | "addToChat"
  | "delete"
  | "duplicate"
  | "compress"
  | "extractHere"
  | "extractTo";

/** What a file's menu shows, wherever it opens: on right-click or from its "More" button. */
export interface FileMenuProps {
  officeStatus?: OfficeStatusResponse | undefined;
  entry: FsEntry;
  onAction: (action: RowContextAction, entry: FsEntry) => void;
  /**
   * How many files and folders this menu's actions would apply to: the
   * whole selection when `entry` is part of a multi-entry selection, else
   * just `entry`. Defaults to `entry` alone. A multi-entry selection
   * disables "Duplicate" and hides "Extract here"/"Extract to", since both
   * only ever make sense for a single entry; a selection with a folder
   * makes the download item read "Download as zip".
   */
  selection?: BrowserSelection;
  /**
   * The folders others share with the active login. With them the menu
   * offers "Leave" on such a folder, hides rename, move, duplicate and
   * delete where only the owner may do them, keeps public links out of
   * `Shared with me`, and offers "Share with people" on the login's own
   * folders. Defaults to none.
   */
  received?: readonly ReceivedGrant[];
  /**
   * Hides "Move to" and "Copy to", for a read-only "virtual listing"
   * (favorites, recents, a tag's files) where the entries do not live in
   * one real folder, so moving or copying "into" the current view makes no
   * sense. Both items show by default.
   */
  hideMoveCopy?: boolean;
  /** Shows "Organize" after "Move to"/"Copy to", when AI is set up. Hidden by default. */
  showOrganize?: boolean;
  /** Shows "Add to chat" after "Organize", when AI is set up. Hidden by default. */
  showChat?: boolean;
  /** Shows "Reveal in folder" above "Open", for a "virtual listing" whose
   * rows are not already inside the folder they live in (favorites,
   * recents, a tag's files). Hidden by default, since the plain file
   * browser is already showing the row's own folder. */
  showReveal?: boolean;
  /** Hides "Compress" and "Extract", for a "virtual listing" that does
   * not run the archive jobs (favorites, recents, a tag's files). Both show
   * by default. */
  hideArchive?: boolean;
  /** The entry is inside an encrypted folder: hides Share, Share with people, Office and
   * Duplicate, which the server does not do there, and Tags and Favorites, whose lists show
   * stored names. An encrypted folder itself never shares. */
  encrypted?: boolean;
  /** Every tag known to the account, for the "Tags" submenu. Defaults to
   * none, so a caller that has not wired up tags yet still renders. */
  tags?: readonly Tag[];
  /** The check state of `tagId` across the group of entries this menu's
   * actions apply to (see `selection`), for that tag's checkbox.
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
}

export interface FileContextMenuProps extends FileMenuProps {
  children: ReactNode;
}

/**
 * The menu parts a file's items are built from, so the right-click menu and the "More"
 * dropdown list the same items in the same order.
 */
interface MenuKit {
  Item: ComponentType<{ onClick?: () => void; disabled?: boolean; children: ReactNode }>;
  CheckboxItem: ComponentType<{
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    children: ReactNode;
  }>;
  Separator: ComponentType;
  Sub: ComponentType<{ children: ReactNode }>;
  SubTrigger: ComponentType<{ children: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children: ReactNode }>;
}

const CONTEXT_MENU_KIT: MenuKit = {
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

const DROPDOWN_MENU_KIT: MenuKit = {
  Item: DropdownMenuItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

const DEFAULT_TAGS: readonly Tag[] = [];
const DEFAULT_RECEIVED: readonly ReceivedGrant[] = [];
const DEFAULT_TAG_CHECK_STATE = (): TagCheckState => "unchecked";
const DEFAULT_NO_OP = () => {};

/** The right-click menu shared by list rows and grid tiles. */
export function FileContextMenu({ children, ...menu }: FileContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <FileMenuItems kit={CONTEXT_MENU_KIT} {...menu} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function stopPropagation(event: MouseEvent) {
  event.stopPropagation();
}

/**
 * A row's "More" button: the same menu as a right-click, for a pointer without a right
 * button and for anyone who looks for it. Clicking it never selects or opens the row.
 */
export function FileActionsMenu({ className, ...menu }: FileMenuProps & { className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`More actions for ${menu.entry.name}`}
            className={className}
            onClick={stopPropagation}
            onDoubleClick={stopPropagation}
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      {/* A right-click in this menu must not reach the row's own context menu around it. */}
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <FileMenuItems kit={DROPDOWN_MENU_KIT} {...menu} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FileMenuItems({
  kit,
  entry,
  officeStatus,
  onAction,
  selection,
  received = DEFAULT_RECEIVED,
  hideMoveCopy = false,
  showOrganize = false,
  showChat = false,
  showReveal = false,
  hideArchive = false,
  encrypted = false,
  tags = DEFAULT_TAGS,
  tagCheckState = DEFAULT_TAG_CHECK_STATE,
  onToggleTag = DEFAULT_NO_OP,
  onOpenTagsEditor = DEFAULT_NO_OP,
  favorite = false,
  onToggleFavorite = DEFAULT_NO_OP,
}: FileMenuProps & { kit: MenuKit }) {
  const group = selection ?? selectionOf([entry]);
  const selectionCount = group.files + group.folders;
  const includesFolder = group.folders > 0;
  const isMultiSelection = selectionCount > 1;
  const archiveKind = entry.kind !== "dir" ? detectArchiveKind(entry.name) : null;
  const canExtract = !isMultiSelection && archiveKind !== null;
  const restrictions = entryRestrictions(entry, received);
  const locked = restrictions.locked !== null;
  const encryptedArea = encrypted || entry.encrypted === true;

  const { Item, CheckboxItem, Separator, Sub, SubTrigger, SubContent } = kit;

  return (
    <>
      {restrictions.publicLink && !encryptedArea && (
        <Item onClick={() => onAction("share", entry)}>
          <Link2Icon />
          Share
        </Item>
      )}
      {restrictions.shareWithPeople && !isMultiSelection && !encryptedArea && (
        <Item onClick={() => onAction("shareWithPeople", entry)}>
          <UsersIcon />
          Share with people
        </Item>
      )}
      <Item onClick={() => onAction("open", entry)}>
        <ExternalLinkIcon />
        Open
      </Item>
      {(encryptedArea ? [] : officeModesFor(entry, officeStatus, selectionCount)).map((mode) => (
        <Item key={mode} onClick={() => onAction(`office:${mode}`, entry)}>
          <ExternalLinkIcon />
          {OFFICE_MODE_LABELS[mode]}
        </Item>
      ))}
      {showReveal && (
        <Item onClick={() => onAction("revealInFolder", entry)}>
          <FolderSearchIcon />
          Reveal in folder
        </Item>
      )}
      <Separator />
      {!locked && (
        <>
          {!encrypted && (
            <Item disabled={isMultiSelection} onClick={() => onAction("duplicate", entry)}>
              <CopyIcon />
              Duplicate
            </Item>
          )}
          <Item onClick={() => onAction("rename", entry)}>
            <PencilIcon />
            Rename
          </Item>
        </>
      )}
      {!hideMoveCopy && (
        <>
          {!locked && (
            <Item onClick={() => onAction("moveTo", entry)}>
              <FolderInputIcon />
              Move to
            </Item>
          )}
          <Item onClick={() => onAction("copyTo", entry)}>
            <FilesIcon />
            Copy to
          </Item>
          {showOrganize && (
            <Item onClick={() => onAction("organize", entry)}>
              <SparklesIcon />
              Organize
            </Item>
          )}
          {showChat && (
            <Item onClick={() => onAction("addToChat", entry)}>
              <MessageSquarePlusIcon />
              Add to chat
            </Item>
          )}
        </>
      )}
      {!encrypted && (
        <>
          <Separator />
          <Sub>
            <SubTrigger>
              <TagIcon />
              Tags
            </SubTrigger>
            <SubContent className="w-52">
              {tags.length === 0 ? (
                <Item disabled>No tags yet</Item>
              ) : (
                tags.map((tag) => {
                  const state = tagCheckState(tag.id);
                  return (
                    <CheckboxItem
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
                    </CheckboxItem>
                  );
                })
              )}
              <Separator />
              <Item onClick={onOpenTagsEditor}>
                <PencilIcon />
                Edit tags
              </Item>
            </SubContent>
          </Sub>
          <Item onClick={() => onToggleFavorite(!favorite)}>
            {favorite ? <StarOffIcon /> : <StarIcon />}
            {favorite ? "Remove from Favorites" : "Add to Favorites"}
          </Item>
        </>
      )}
      {!hideArchive && !encryptedArea && (
        <>
          <Separator />
          <Item onClick={() => onAction("compress", entry)}>
            <FileArchiveIcon />
            Compress
          </Item>
          {canExtract && (
            <>
              {!locked && (
                <Item onClick={() => onAction("extractHere", entry)}>
                  <PackageOpenIcon />
                  Extract here
                </Item>
              )}
              <Item onClick={() => onAction("extractTo", entry)}>
                <PackageOpenIcon />
                Extract to
              </Item>
            </>
          )}
        </>
      )}
      <Separator />
      <Item onClick={() => onAction("download", entry)}>
        <DownloadIcon />
        {includesFolder ? "Download as zip" : "Download"}
      </Item>
      {restrictions.leave !== null && !isMultiSelection && (
        <>
          <Separator />
          <Item onClick={() => onAction("leave", entry)}>
            <LogOutIcon />
            Leave
          </Item>
        </>
      )}
      {!locked && (
        <>
          <Separator />
          <Item onClick={() => onAction("delete", entry)}>
            <Trash2Icon />
            Move to Trash
          </Item>
        </>
      )}
    </>
  );
}
