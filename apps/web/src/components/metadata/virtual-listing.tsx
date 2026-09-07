"use client";

import type { FsEntry } from "@fdrive/contracts";
import { baseName, parentPath } from "@fdrive/core";
import { XIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useMemo, useReducer, useState } from "react";
import { toast } from "sonner";
import { ShareDialog } from "@/components/shares/share-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  apiClient,
  contextEntries,
  DeleteDialog,
  describeFsError,
  EMPTY_SELECTION,
  FileList,
  PageHeader,
  pathToHref,
  RenameDialog,
  type RowContextAction,
  type SelectionAction,
  type SelectionState,
  selectionReducer,
  useDelete,
  useDuplicate,
  useRename,
  useTrashStatus,
  viewHref,
} from "@/lib/metadata/deps";
import {
  useResolvedEntries,
  useSetFileTags,
  useTags,
  useToggleFavorite,
} from "@/lib/metadata/queries";
import { toggleTagId } from "@/lib/metadata/tag-set";

function toRoute(href: string): Route {
  return href as Route;
}

export interface VirtualListingProps {
  /** The page's title, shown in the toolbar next to the item count. */
  readonly title: string;
  /** The real fs paths to resolve and list; order is preserved. */
  readonly paths: readonly string[];
  /** Called for a path that no longer resolves (deleted, moved out of
   * scope), when the user asks to remove it from this view. */
  readonly onRemoveMissing: (path: string) => void;
}

/**
 * A read-only listing fed by a list of paths rather than one real folder:
 * backs `/favorites`, `/recents`, and `/tags/[id]`. Reuses the ordinary
 * `FileList` (list view only) for rows that still resolve; rows that no
 * longer exist show muted, with a hint and a remove action instead. Rows
 * open (folders navigate, files preview), support "Reveal in folder", and
 * get the same context menu as the file browser minus move, copy,
 * compress, and extract, which do not make sense for a set of paths that
 * do not share one real folder.
 */
export function VirtualListing({ title, paths, onRemoveMissing }: VirtualListingProps) {
  const router = useRouter();
  const { entries: resolved, isLoading } = useResolvedEntries(paths);
  const tagsQuery = useTags();
  const tags = tagsQuery.data ?? [];
  const setFileTags = useSetFileTags();
  const toggleFavorite = useToggleFavorite();
  const rename = useRename();
  const remove = useDelete();
  const duplicate = useDuplicate();
  const { data: trashStatus } = useTrashStatus();

  const liveEntries = useMemo(
    () => resolved.flatMap((item) => (item.entry !== null ? [item.entry] : [])),
    [resolved],
  );
  const missing = useMemo(() => resolved.filter((item) => item.entry === null), [resolved]);
  const orderedPaths = useMemo(() => liveEntries.map((entry) => entry.path), [liveEntries]);

  const [selection, dispatchSelection] = useReducer(
    (state: SelectionState, action: SelectionAction) =>
      selectionReducer(state, action, orderedPaths),
    EMPTY_SELECTION,
  );
  const [sharing, setSharing] = useState<FsEntry[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<FsEntry | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<FsEntry[]>([]);

  function currentTagIds(path: string): readonly string[] {
    return liveEntries.find((candidate) => candidate.path === path)?.meta?.tagIds ?? [];
  }

  function handleOpen(entry: FsEntry) {
    router.push(toRoute(entry.kind === "dir" ? pathToHref(entry.path) : viewHref(entry.path)));
  }

  function handleDownload(entry: FsEntry) {
    const url = apiClient.downloadUrl(entry.path);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = entry.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function handleContextAction(action: RowContextAction, entry: FsEntry) {
    switch (action) {
      case "share":
        setSharing(contextEntries(entry, liveEntries, selection.selected));
        break;
      case "open":
        handleOpen(entry);
        break;
      case "revealInFolder":
        router.push(toRoute(pathToHref(parentPath(entry.path))));
        break;
      case "download":
        handleDownload(entry);
        break;
      case "rename":
        setRenameTarget(entry);
        break;
      case "delete":
        setDeleteTargets(contextEntries(entry, liveEntries, selection.selected));
        break;
      case "duplicate":
        duplicate.mutate(entry.path, {
          onSuccess: (newEntry) => toast.success(`Duplicated as "${newEntry.name}"`),
        });
        break;
      default:
        break;
    }
  }

  function handleToggleTag(paths2: readonly string[], tagId: string, checked: boolean) {
    setFileTags.mutate(
      paths2.map((path) => ({ path, tagIds: toggleTagId(currentTagIds(path), tagId, checked) })),
    );
  }

  function handleToggleFavorite(paths2: readonly string[], next: boolean) {
    for (const path of paths2) {
      toggleFavorite.mutate({ path, favorite: next });
    }
  }

  function handleRenameSubmit(newName: string) {
    if (renameTarget === null) {
      return;
    }
    rename.mutate({ path: renameTarget.path, newName }, { onSuccess: () => setRenameTarget(null) });
  }

  function deleteItemKind(entry: FsEntry): "file" | "dir" {
    return entry.kind === "dir" ? "dir" : "file";
  }

  function handleDeleteConfirm() {
    remove.mutate(
      deleteTargets.map((entry) => ({ path: entry.path, kind: deleteItemKind(entry) })),
      { onSuccess: () => setDeleteTargets([]) },
    );
  }

  const count = paths.length;

  return (
    <>
      <PageHeader
        breadcrumbs={<span className="truncate font-medium text-sm">{title}</span>}
        actions={
          <Badge variant="secondary">
            {count} {count === 1 ? "item" : "items"}
          </Badge>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static, never-reordered list of placeholder rows
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <>
            {liveEntries.length === 0 && missing.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground text-sm">
                Nothing here yet.
              </div>
            ) : (
              <div className="min-h-0 flex-1">
                <FileList
                  entries={liveEntries}
                  selected={selection.selected}
                  focusedPath={selection.focus}
                  onEntryClick={(entry, modifiers) =>
                    dispatchSelection({ type: "click", path: entry.path, modifiers })
                  }
                  onEntryDoubleClick={handleOpen}
                  onContextAction={handleContextAction}
                  getDragPaths={(entry) => [entry.path]}
                  onInternalDrop={() => {}}
                  onToggleSelectAll={() =>
                    dispatchSelection({ type: "toggleAll", visiblePaths: orderedPaths })
                  }
                  onClearSelection={() => dispatchSelection({ type: "clear" })}
                  tags={tags}
                  onToggleTag={handleToggleTag}
                  onToggleFavorite={handleToggleFavorite}
                  hideMoveCopy
                  hideArchive
                  showReveal
                  trashAvailable={trashStatus?.available === true}
                />
              </div>
            )}
            {missing.length > 0 && (
              <div className="max-h-40 shrink-0 overflow-auto border-t p-2">
                {missing.map((item) => (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-sm"
                  >
                    <span className="truncate">{baseName(item.path)} — no longer exists</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${baseName(item.path)}`}
                      onClick={() => onRemoveMissing(item.path)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {sharing !== null && <ShareDialog entries={sharing} onClose={() => setSharing(null)} />}
      <RenameDialog
        entry={renameTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
          }
        }}
        onRename={handleRenameSubmit}
        pending={rename.isPending}
      />
      <DeleteDialog
        entries={deleteTargets}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTargets([]);
          }
        }}
        onConfirm={handleDeleteConfirm}
        pending={remove.isPending}
        trash={trashStatus ?? null}
      />
    </>
  );
}

/** Re-exported so callers can describe an error from a mutation this
 * component triggers indirectly (e.g. a page's own remove-missing handler). */
export { describeFsError };
