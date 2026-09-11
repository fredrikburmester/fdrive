"use client";

import type { FsEntry } from "@fdrive/contracts";
import { baseName, parentPath } from "@fdrive/core";
import { XIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { VirtualFileListing } from "@/components/files/virtual-file-listing";
import { ShareDialog } from "@/components/shares/share-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultArchiveName } from "@/lib/files/archive";
import {
  type AnchorDownloader,
  createAnchorDownloader,
  type DocumentLike,
  type DownloadDeps,
  downloadMany,
  downloadSingle,
  planDownload,
} from "@/lib/files/download";
import {
  apiClient,
  capabilitiesFor,
  DeleteDialog,
  describeFsError,
  PageHeader,
  pathToHref,
  RenameDialog,
  type RowContextAction,
  trashAvailabilityFor,
  useDelete,
  useDuplicate,
  useMe,
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

/**
 * Adapts the real, global `document` to `download.ts`'s minimal
 * `DocumentLike`, the same way the file browser does: the cast is confined
 * to this one boundary, since `download.ts` only ever creates, appends,
 * clicks and removes a single anchor.
 */
function adaptDocument(doc: Document): DocumentLike {
  return {
    createElement: (tag) => doc.createElement(tag),
    body: {
      appendChild: (node) => {
        doc.body.appendChild(node as unknown as Node);
      },
      removeChild: (node) => {
        doc.body.removeChild(node as unknown as Node);
      },
    },
  };
}

/** Builds a fresh `DownloadDeps` bound to the current `document`. Only ever
 * called from an event handler, never at render time, so it never runs
 * during server-side rendering. */
function buildDownloadDeps(anchor: AnchorDownloader): DownloadDeps {
  return {
    downloadUrl: (downloadPath, opts) => apiClient.downloadUrl(downloadPath, opts),
    zip: (paths, name) => apiClient.zip(paths, name),
    anchor,
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
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
 * backs `/favorites`, `/recents`, and `/tags/[id]`. It follows the global
 * default view for rows that still resolve; rows that no
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
  const { data: me } = useMe();
  const capabilities = capabilitiesFor(me);

  const liveEntries = useMemo(
    () => resolved.flatMap((item) => (item.entry !== null ? [item.entry] : [])),
    [resolved],
  );
  const missing = useMemo(() => resolved.filter((item) => item.entry === null), [resolved]);
  const anchorRef = useRef<AnchorDownloader | null>(null);
  const [sharing, setSharing] = useState<FsEntry[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<FsEntry | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<FsEntry[]>([]);

  function handleOpen(entry: FsEntry) {
    router.push(toRoute(entry.kind === "dir" ? pathToHref(entry.path) : viewHref(entry.path)));
  }

  function getAnchorDownloader(): AnchorDownloader {
    if (anchorRef.current === null) {
      anchorRef.current = createAnchorDownloader(adaptDocument(document));
    }
    return anchorRef.current;
  }

  /**
   * Downloads `targets` the way the login's provider allows, sharing the
   * file browser's plan: one file streams directly, a provider with `zip`
   * archives anything else (a folder has no byte stream of its own, so
   * asking for it directly would only 400), and a provider without `zip`
   * hands out each file on its own and skips folders.
   */
  function handleDownload(targets: readonly FsEntry[]) {
    const plan = planDownload(targets, capabilities.zip);
    if (plan === null) {
      return;
    }
    const deps = buildDownloadDeps(getAnchorDownloader());
    switch (plan.kind) {
      case "single":
        downloadSingle(plan.path, deps);
        break;
      case "zip":
        downloadMany(plan.paths, deps, `${defaultArchiveName(plan.paths)}.zip`).catch(() =>
          toast.error("Could not download the selection."),
        );
        break;
      case "each":
        for (const target of plan.paths) {
          downloadSingle(target, deps);
        }
        break;
    }
  }

  function handleContextAction(
    action: RowContextAction,
    entry: FsEntry,
    context: readonly FsEntry[],
  ) {
    switch (action) {
      case "share":
        setSharing([...context]);
        break;
      case "open":
        handleOpen(entry);
        break;
      case "revealInFolder":
        router.push(toRoute(pathToHref(parentPath(entry.path))));
        break;
      case "download":
        handleDownload(context);
        break;
      case "rename":
        setRenameTarget(entry);
        break;
      case "delete":
        setDeleteTargets([...context]);
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

  function handleToggleTag(entries: readonly FsEntry[], tagId: string, checked: boolean) {
    setFileTags.mutate(
      entries.map((entry) => ({
        path: entry.path,
        tagIds: toggleTagId(entry.meta?.tagIds ?? [], tagId, checked),
      })),
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
                <VirtualFileListing
                  entries={liveEntries}
                  onOpen={handleOpen}
                  onContextAction={handleContextAction}
                  tags={tags}
                  onToggleTag={handleToggleTag}
                  onToggleFavorite={handleToggleFavorite}
                  hideMoveCopy
                  hideArchive
                  showReveal
                  capabilities={capabilities}
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
        trash={trashAvailabilityFor(capabilities, trashStatus)}
      />
    </>
  );
}

/** Re-exported so callers can describe an error from a mutation this
 * component triggers indirectly (e.g. a page's own remove-missing handler). */
export { describeFsError };
