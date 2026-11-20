"use client";

import type { FsEntry, OfficeStatusResponse, ReceivedGrant, Tag } from "@fdrive/contracts";
import { DEFAULT_LIST_DENSITY, type ListDensity, ROW_HEIGHTS } from "@/lib/files/density";
import type { ScrollRequest } from "@/lib/files/reveal";
import { useListDesign } from "@/lib/files/use-list-design";
import { BetaFileList } from "./beta-file-list";
import { ClassicFileList } from "./classic-file-list";
import type { RowContextAction } from "./file-context-menu";

/** The row height at the default ("standard") density. */
export const FILE_ROW_HEIGHT = ROW_HEIGHTS[DEFAULT_LIST_DENSITY];

export interface ClickModifierKeys {
  shift: boolean;
  meta: boolean;
}

export interface FileListProps {
  officeStatus?: OfficeStatusResponse | undefined;
  entries: readonly FsEntry[];
  selected: ReadonlySet<string>;
  focusedPath: string | null;
  onEntryClick: (entry: FsEntry, modifiers: ClickModifierKeys) => void;
  onEntryDoubleClick: (entry: FsEntry) => void;
  onContextAction: (action: RowContextAction, entry: FsEntry) => void;
  getDragPaths: (entry: FsEntry) => string[];
  onInternalDrop: (paths: string[], targetPath: string, effect: "move" | "copy") => void;
  /** Toggles between selecting every visible row and none, from the header checkbox. */
  onToggleSelectAll: () => void;
  /** Clears the selection, for a plain click on empty listing space. */
  onClearSelection: () => void;
  /**
   * Present only in tree view: each row's indent depth, keyed by path. Rows
   * missing from the map (or when this prop is absent entirely) render
   * without a disclosure chevron, at depth 0, as in the plain list view.
   */
  treeDepths?: ReadonlyMap<string, number>;
  /** Which folder paths are expanded, for the chevron's rotation, in tree view. */
  treeExpanded?: ReadonlySet<string>;
  /** Called when a folder row's disclosure chevron is toggled, in tree view. */
  onToggleTreeExpand?: (entry: FsEntry) => void;
  /** Every tag known to the account, for each row's tag dots and the "Tags"
   * context menu submenu. Defaults to none. */
  tags?: readonly Tag[];
  /** Adds or removes `tagId` on every entry in the group a row's context
   * menu action would apply to (see `contextEntries`). Defaults to a no-op. */
  onToggleTag?: (paths: readonly string[], tagId: string, checked: boolean) => void;
  /** Opens the full tag editor for the group of entries a row's context
   * menu action would apply to. Defaults to a no-op. */
  onOpenTagsEditor?: (entries: readonly FsEntry[]) => void;
  /** Favorites (or unfavorites) every entry in the group a row's context
   * menu action would apply to. Defaults to a no-op. */
  onToggleFavorite?: (paths: readonly string[], next: boolean) => void;
  /** Hides "Move to" and "Copy to" in every row's context menu, for a
   * read-only "virtual listing". Defaults to `false`. */
  hideMoveCopy?: boolean;
  /** Shows "Reveal in folder" in every row's context menu, for a "virtual
   * listing" whose rows are not already inside their own folder. Defaults
   * to `false`. */
  showReveal?: boolean;
  /** Hides "Compress" and "Extract" in every row's context menu, for
   * a "virtual listing" that does not run the archive jobs. Defaults to
   * `false`. */
  /** Shows "Organize" in each row's context menu (see `FileContextMenu`). */
  showOrganize?: boolean;
  /** Shows "Add to chat" in the row context menu, when AI is set up. Hidden by default. */
  showChat?: boolean;
  hideArchive?: boolean;
  /** Rows are inside an encrypted folder; see `FileContextMenu`. */
  encrypted?: boolean;
  /** The folders others share with the active login: captions in `Shared with me`, and
   * what each context menu offers (see `FileContextMenu`). Defaults to none. */
  received?: readonly ReceivedGrant[];
  /** A request to scroll a specific entry into view, identified by unique token. */
  scrollRequest?: ScrollRequest | null;
  /** Callback fired after the virtualizer has scrolled to the requested entry. */
  onScrollConsumed?: (token: number) => void;
  /** Whether to show image thumbnails in place of generic file icons. Defaults to false. */
  showThumbnails?: boolean;
  /** Row height preset (see `listRowHeight`). Defaults to "standard". */
  density?: ListDensity;
}

/** The list view of a folder's entries, in the design this browser's File list setting picks. */
export function FileList(props: FileListProps) {
  const [design] = useListDesign();
  return design === "beta" ? <BetaFileList {...props} /> : <ClassicFileList {...props} />;
}
