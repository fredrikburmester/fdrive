"use client";

import {
  type EncryptedFolderInfo,
  hasEncryptedName,
  isEncryptedName,
  type TrashEntry,
} from "@fdrive/contracts";
import { isRoot, joinPath, parentPath, splitSegments } from "@fdrive/core";
import { decryptName } from "@fdrive/crypto";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Loader2, LockIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DestinationPicker } from "@/components/files/destination-picker";
import { EmptyState } from "@/components/files/empty-state";
import { ErrorState } from "@/components/files/error-state";
import { PageHeader } from "@/components/shell/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { useTrashSettings } from "@/lib/api/trash-settings-queries";
import { keyStore, useKeyState } from "@/lib/encryption/keys";
import { useEncryptionStatus } from "@/lib/encryption/queries";
import { describeFsError } from "@/lib/files/queries";
import { useDefaultView } from "@/lib/files/use-default-view";
import {
  emptiedToastMessage,
  emptyTrashConfirmDescription,
  originalFolderLabel,
  purgeConfirmDescription,
  purgedToastMessage,
  restoreConflictMessage,
  restoredToastMessage,
  retentionNote,
} from "@/lib/trash/format";
import {
  isRestoreConflict,
  useTrash,
  useTrashEmpty,
  useTrashPurge,
  useTrashRestore,
} from "@/lib/trash/queries";
import { useFormatters } from "@/lib/use-format-preferences";

/** How a trashed item reads: its name, null for an encrypted one this browser cannot read, and its original folder. */
interface TrashLabel {
  readonly name: string | null;
  readonly folder: string;
}

const ENCRYPTED_ITEM = "Encrypted item";

/**
 * The "Original folder" label for `originalPath`: its parent, or "Home" at the
 * top. Encrypted names read through `names`; the label stops at the first one
 * this browser cannot read.
 */
function folderLabel(
  originalPath: string,
  names: ReadonlyMap<string, string | null> = new Map(),
): string {
  const parent = parentPath(originalPath);
  if (isRoot(parent)) return "Home";
  const shown: string[] = [];
  for (const segment of splitSegments(parent)) {
    const name = isEncryptedName(segment) ? (names.get(segment) ?? null) : segment;
    if (name === null) {
      shown.push("…");
      break;
    }
    shown.push(name);
  }
  return `/${shown.join("/")}`;
}

/** The label of an item from inside an encrypted folder, before or without its key. */
function lockedLabel(entry: TrashEntry): TrashLabel {
  return {
    name: isEncryptedName(entry.name) ? null : entry.name,
    folder: folderLabel(entry.originalPath),
  };
}

/** Decrypts the names of items trashed from inside encrypted folders, here in the browser. */
async function decryptLabels(
  entries: readonly TrashEntry[],
  folders: ReadonlyMap<string, EncryptedFolderInfo | null>,
): Promise<Record<string, TrashLabel>> {
  const labels: Record<string, TrashLabel> = {};
  for (const entry of entries) {
    const info = folders.get(parentPath(entry.originalPath)) ?? null;
    const folder = info === null ? null : await keyStore.folder(info).catch(() => null);
    if (folder === null) continue;
    const names = new Map<string, string | null>();
    for (const segment of splitSegments(entry.originalPath)) {
      if (isEncryptedName(segment) && !names.has(segment)) {
        names.set(segment, await decryptName(segment, folder.nameKey, folder.id));
      }
    }
    labels[entry.id] = {
      name: isEncryptedName(entry.name) ? (names.get(entry.name) ?? null) : entry.name,
      folder: folderLabel(entry.originalPath, names),
    };
  }
  return labels;
}

/**
 * How each trashed item reads. Items from inside an encrypted folder show
 * their decrypted names once this browser holds the key; the folder's
 * marker comes from the item's original parent, and the names never leave
 * the browser.
 */
function useTrashLabels(entries: readonly TrashEntry[]): (entry: TrashEntry) => TrashLabel {
  const encrypted = useMemo(
    () => entries.filter((entry) => hasEncryptedName(entry.originalPath)),
    [entries],
  );
  // Learns whether this browser holds the key, once there is something to open with it.
  useEncryptionStatus(encrypted.length > 0);
  const keyState = useKeyState();
  const recipient = keyState.status === "unlocked" ? keyState.recipient : null;
  const parents = useMemo(
    () => [...new Set(encrypted.map((entry) => parentPath(entry.originalPath)))],
    [encrypted],
  );
  const folders = useQueries({
    queries: parents.map((path) => ({
      queryKey: queryKeys.encryption.folder(path),
      queryFn: async () => (await apiClient.encryptedFolder(path)).folder,
      enabled: recipient !== null,
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const infos = new Map(parents.map((path, index) => [path, folders[index]?.data ?? null]));
  const labels = useQuery({
    queryKey: [
      "encryption",
      "trash-names",
      recipient,
      encrypted.map((entry) => [entry.id, entry.originalPath]),
      [...infos.values()].map((info) => info?.marker.mac ?? null),
    ],
    queryFn: () => decryptLabels(encrypted, infos),
    enabled:
      recipient !== null &&
      encrypted.length > 0 &&
      folders.every((folder) => folder.isSuccess || folder.isError),
    // Clear names stay in memory only while something shows them.
    gcTime: 0,
    placeholderData: (previous) => previous,
  });
  const decrypted = recipient === null ? undefined : labels.data;
  return (entry) => {
    if (!hasEncryptedName(entry.originalPath)) {
      return { name: entry.name, folder: originalFolderLabel(entry.originalPath) };
    }
    return decrypted?.[entry.id] ?? lockedLabel(entry);
  };
}

/** A trashed item's name, or "Encrypted item" with a lock where it cannot be read. */
function TrashName({ label }: { label: TrashLabel }) {
  if (label.name !== null) return label.name;
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <LockIcon className="size-3.5" aria-hidden="true" />
      {ENCRYPTED_ITEM}
    </span>
  );
}

/** What the confirmation dialog is asking about: permanently deleting the
 * given selection, or emptying the whole trash. */
type ConfirmAction =
  | { readonly kind: "purge"; readonly ids: readonly string[] }
  | { readonly kind: "empty" };

/** The trash listing at `/trash`: restore, restore-to-a-different-folder,
 * permanent delete, and empty, plus loading/empty/error states. */
export function TrashPage() {
  const { formatBytes, formatDate } = useFormatters();
  const [viewMode] = useDefaultView();
  const trash = useTrash();
  const restore = useTrashRestore();
  const purge = useTrashPurge();
  const emptyTrash = useTrashEmpty();
  const retention = retentionNote(useTrashSettings().data?.retentionDays);

  const entries = useMemo(() => trash.data?.entries ?? [], [trash.data]);
  const labelOf = useTrashLabels(entries);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [restoreTargetEntry, setRestoreTargetEntry] = useState<TrashEntry | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.id)),
    [entries, selected],
  );
  const allSelected = entries.length > 0 && selected.size === entries.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(entries.map((entry) => entry.id)));
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  function dropFromSelection(ids: readonly string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        next.delete(id);
      }
      return next;
    });
  }

  function offerRestoreElsewhere(entry: TrashEntry | undefined) {
    if (entry === undefined) {
      return;
    }
    toast.error(restoreConflictMessage(labelOf(entry).name ?? ENCRYPTED_ITEM), {
      action: { label: "Restore to", onClick: () => setRestoreTargetEntry(entry) },
    });
  }

  function handleRestoreSelected() {
    const ids = selectedEntries.map((entry) => entry.id);
    if (ids.length === 0) {
      return;
    }
    restore.mutate(
      { ids },
      {
        onSuccess: () => {
          toast.success(restoredToastMessage(ids.length));
          dropFromSelection(ids);
        },
        onError: (error) => {
          if (ids.length === 1 && isRestoreConflict(error)) {
            offerRestoreElsewhere(selectedEntries[0]);
          }
        },
      },
    );
  }

  /** Restores the picked entry into `folder`. The picker stays open, showing
   * its busy state, until the request settles; a conflict then closes it and
   * offers the picker again from the toast. */
  function handleRestoreToConfirm(folder: string) {
    const entry = restoreTargetEntry;
    if (entry === null || restore.isPending) {
      return;
    }
    restore.mutate(
      { ids: [entry.id], target: joinPath(folder, entry.name) },
      {
        onSuccess: () => {
          toast.success(restoredToastMessage(1));
          dropFromSelection([entry.id]);
        },
        onError: (error) => {
          if (isRestoreConflict(error)) {
            offerRestoreElsewhere(entry);
          }
        },
        onSettled: () => {
          setRestoreTargetEntry(null);
        },
      },
    );
  }

  function handlePurgeConfirm() {
    if (confirmAction?.kind !== "purge") {
      return;
    }
    const ids = confirmAction.ids;
    setConfirmAction(null);
    purge.mutate([...ids], {
      onSuccess: () => {
        toast.success(purgedToastMessage(ids.length));
        dropFromSelection(ids);
      },
    });
  }

  function handleEmptyConfirm() {
    if (confirmAction?.kind !== "empty") {
      return;
    }
    const count = entries.length;
    setConfirmAction(null);
    emptyTrash.mutate(undefined, {
      onSuccess: () => {
        toast.success(emptiedToastMessage(count));
        setSelected(new Set());
      },
    });
  }

  // A restore started from the toolbar; a "Restore to" restore shows its
  // busy state in the picker instead, while the toolbar is merely disabled.
  const restoringSelection = restore.isPending && restoreTargetEntry === null;

  return (
    <>
      <PageHeader breadcrumbs={<span className="font-medium">Trash</span>} />
      <main className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Files and folders you delete stay here until you restore them or delete them
            permanently.{retention === null ? null : ` ${retention}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selected.size === 0 || restore.isPending}
            aria-busy={restoringSelection}
            onClick={handleRestoreSelected}
          >
            {restoringSelection && <Loader2 className="animate-spin" aria-hidden="true" />}
            {restoringSelection ? "Restoring…" : "Restore"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selectedEntries.length !== 1 || restore.isPending}
            onClick={() => {
              const only = selectedEntries[0];
              if (only !== undefined) {
                setRestoreTargetEntry(only);
              }
            }}
          >
            Restore to
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setConfirmAction({ kind: "purge", ids: [...selected] })}
          >
            Delete permanently
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={entries.length === 0}
            onClick={() => setConfirmAction({ kind: "empty" })}
          >
            Empty Trash
          </Button>
        </div>

        {trash.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static, never-reordered list of placeholder rows
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : trash.isError ? (
          <ErrorState
            message={describeFsError(trash.error, "Could not load the trash.")}
            onRetry={() => trash.refetch()}
          />
        ) : entries.length === 0 ? (
          <EmptyState
            title="Trash is empty"
            description="Items you delete show up here until you restore them or delete them permanently."
          />
        ) : (
          <>
            {viewMode === "grid" ? (
              <>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onCheckedChange={toggleSelectAll}
                    aria-label={allSelected ? "Deselect all" : "Select all"}
                  />
                  <span>{selected.size > 0 ? `${selected.size} selected` : "Select all"}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-slot="trash-grid">
                  {entries.map((entry) => {
                    const deletedAt = new Date(entry.deletedAt);
                    const label = labelOf(entry);
                    return (
                      <div key={entry.id} className="min-w-0 rounded-lg border p-3">
                        <div className="flex items-start gap-2">
                          <Checkbox
                            checked={selected.has(entry.id)}
                            onCheckedChange={(checked) => toggleOne(entry.id, checked)}
                            aria-label={`Select ${label.name ?? ENCRYPTED_ITEM}`}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">
                              <TrashName label={label} />
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{label.folder}</p>
                          </div>
                        </div>
                        <div className="mt-3 flex justify-between gap-2 text-xs text-muted-foreground">
                          <span>{formatBytes(entry.size)}</span>
                          <span title={deletedAt.toLocaleString()}>{formatDate(deletedAt)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              // Trash has no live directory paths to resolve. Tree therefore intentionally
              // uses the same flat rows as list, while the shared global default still selects it.
              <Table data-slot={viewMode === "tree" ? "trash-tree" : "trash-list"}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        onCheckedChange={toggleSelectAll}
                        aria-label={allSelected ? "Deselect all" : "Select all"}
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Original folder</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Deleted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const deletedAt = new Date(entry.deletedAt);
                    const label = labelOf(entry);
                    return (
                      <TableRow key={entry.id}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(entry.id)}
                            onCheckedChange={(checked) => toggleOne(entry.id, checked)}
                            aria-label={`Select ${label.name ?? ENCRYPTED_ITEM}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          <TrashName label={label} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{label.folder}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatBytes(entry.size)}
                        </TableCell>
                        <TableCell
                          className="text-muted-foreground"
                          title={deletedAt.toLocaleString()}
                        >
                          {formatDate(deletedAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {trash.data?.truncated === true && (
              <p className="text-xs text-muted-foreground">
                Showing the first {entries.length} items.
              </p>
            )}
          </>
        )}
      </main>

      {restoreTargetEntry !== null && (
        <DestinationPicker
          open
          mode="restoreTo"
          onOpenChange={(open) => {
            if (!open) {
              setRestoreTargetEntry(null);
            }
          }}
          onConfirm={handleRestoreToConfirm}
          pending={restore.isPending}
        />
      )}

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmAction(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.kind === "empty" ? "Empty Trash?" : "Delete permanently?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.kind === "empty"
                ? emptyTrashConfirmDescription(entries.length)
                : purgeConfirmDescription(confirmAction?.ids.length ?? 0)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={purge.isPending || emptyTrash.isPending}
              onClick={() => {
                if (confirmAction?.kind === "empty") {
                  handleEmptyConfirm();
                } else {
                  handlePurgeConfirm();
                }
              }}
            >
              {confirmAction?.kind === "empty" ? "Empty Trash" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
