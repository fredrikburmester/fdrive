/**
 * Single indirection point for the modules this chunk (tags, favorites,
 * recents) depends on but does not own: the shell's API client and query
 * keys, and the file browser's icon, path/URL, reveal, and selection
 * helpers. Everything in `components/metadata` and `lib/metadata` imports
 * these names from here rather than from the real paths directly, so a
 * future seam only has to repoint the re-exports below instead of every
 * call site.
 */
import type { ApiClient } from "@fdrive/contracts";

export { DeleteDialog } from "@/components/files/delete-dialog";
export { FileContextMenu, type RowContextAction } from "@/components/files/file-context-menu";
export { FileIcon } from "@/components/files/file-icon";
export { FileList } from "@/components/files/file-list";
export { RenameDialog } from "@/components/files/rename-dialog";
export { PageHeader } from "@/components/shell/page-header";
export { apiClient, snapshotTabApiClient } from "@/lib/api/client";
export { queryKeys } from "@/lib/api/keys";
export { pathToHref, viewHref } from "@/lib/files/path-url";
export { describeFsError, useDelete, useDuplicate, useRename } from "@/lib/files/queries";
export { revealTarget } from "@/lib/files/reveal";
export {
  contextEntries,
  contextSelectionCount,
  EMPTY_SELECTION,
  type SelectionAction,
  type SelectionState,
  selectionReducer,
} from "@/lib/files/selection";
export { readJson, type StorageLike, writeJson } from "@/lib/files/storage";
export type { ApiClient };
