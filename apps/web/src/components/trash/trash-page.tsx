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
import { Loader2, LockIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DestinationPicker } from "@/components/files/destination-picker";
import { PageHeader } from "@/components/shell/page-header";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  PageBar,
  PageBody,
  PageEmpty,
} from "@/components/shell/page-layout";
import { PHONE_TARGET, RowsSkeleton, RowText, TruncatedCell } from "@/components/shell/page-rows";
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
import { useIsMobile } from "@/hooks/use-mobile";
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
  itemCountLabel,
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
  const mobile = useIsMobile();
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

  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const selectAllLabel = allSelected ? "Deselect all" : "Select all";
  const selectAll = (
    <Checkbox
      checked={allSelected}
      indeterminate={someSelected}
      onCheckedChange={toggleSelectAll}
      aria-label={selectAllLabel}
    />
  );

  return (
    <>
      <PageHeader breadcrumbs={<h1 className="truncate font-medium text-sm">Trash</h1>} />
      <PageBody>
        <PageBar>
          {trash.data !== undefined && (
            <span className="text-foreground">
              {selected.size > 0 ? `${selected.size} selected` : itemCountLabel(entries.length)}
            </span>
          )}
          {entries.length > 0 && <span>{formatBytes(totalSize)}</span>}
          {retention !== null && <span>{retention}</span>}
          {/* Two by two on a phone, where four buttons side by side would not fit. */}
          <div className="flex items-center gap-1.5 max-md:grid max-md:w-full max-md:grid-cols-2 md:ml-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={PHONE_TARGET}
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
              className={PHONE_TARGET}
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
              className={PHONE_TARGET}
              disabled={selected.size === 0}
              onClick={() => setConfirmAction({ kind: "purge", ids: [...selected] })}
            >
              Delete permanently
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={PHONE_TARGET}
              disabled={entries.length === 0}
              onClick={() => setConfirmAction({ kind: "empty" })}
            >
              Empty Trash
            </Button>
          </div>
        </PageBar>

        {trash.isLoading ? (
          <RowsSkeleton label="Loading Trash…" />
        ) : trash.isError ? (
          <PageEmpty
            icon={TriangleAlertIcon}
            title="Could not load Trash"
            description={describeFsError(trash.error, "Could not load the trash.")}
            action={
              <Button variant="outline" size="sm" onClick={() => trash.refetch()}>
                Try again
              </Button>
            }
          />
        ) : entries.length === 0 ? (
          <PageEmpty
            icon={Trash2Icon}
            title="Trash is empty"
            description="Items you delete show up here until you restore them or delete them permanently."
          />
        ) : (
          <>
            {viewMode === "grid" ? (
              <>
                <div className="flex h-9 items-center gap-3 border-border border-b px-3 text-muted-foreground text-xs">
                  {selectAll}
                  <span>{selectAllLabel}</span>
                </div>
                <div
                  className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]"
                  data-slot="trash-grid"
                >
                  {entries.map((entry) => {
                    const deletedAt = new Date(entry.deletedAt);
                    const label = labelOf(entry);
                    return (
                      <div
                        key={entry.id}
                        data-state={selected.has(entry.id) ? "selected" : undefined}
                        className="flex min-w-0 items-start gap-3 border-border/60 border-r border-b px-3 py-2.5 hover:bg-muted/60 data-[state=selected]:bg-ring/10"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={selected.has(entry.id)}
                          onCheckedChange={(checked) => toggleOne(entry.id, checked)}
                          aria-label={`Select ${label.name ?? ENCRYPTED_ITEM}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">
                            <TrashName label={label} />
                          </p>
                          <p className="truncate text-muted-foreground text-xs">{label.folder}</p>
                          <p className="mt-1 flex justify-between gap-2 text-muted-foreground text-xs">
                            <span>{formatBytes(entry.size)}</span>
                            <span title={deletedAt.toLocaleString()}>{formatDate(deletedAt)}</span>
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              // Trash has no live directory paths to resolve. Tree therefore intentionally
              // uses the same flat rows as list, while the shared global default still selects it.
              <DataTable
                data-slot={viewMode === "tree" ? "trash-tree" : "trash-list"}
                className="table-fixed"
              >
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead className="w-9">{selectAll}</DataTableHead>
                    <DataTableHead>Name</DataTableHead>
                    {!mobile && (
                      <>
                        <DataTableHead className="w-[32%]">Original folder</DataTableHead>
                        <DataTableHead className="w-24 text-right">Size</DataTableHead>
                        <DataTableHead className="w-32">Deleted</DataTableHead>
                      </>
                    )}
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {entries.map((entry) => {
                    const deletedAt = new Date(entry.deletedAt);
                    const label = labelOf(entry);
                    const name = <TrashName label={label} />;
                    return (
                      <DataTableRow
                        key={entry.id}
                        data-state={selected.has(entry.id) ? "selected" : undefined}
                        className={mobile ? "h-14" : undefined}
                      >
                        <DataTableCell>
                          <Checkbox
                            checked={selected.has(entry.id)}
                            onCheckedChange={(checked) => toggleOne(entry.id, checked)}
                            aria-label={`Select ${label.name ?? ENCRYPTED_ITEM}`}
                          />
                        </DataTableCell>
                        {mobile ? (
                          <DataTableCell>
                            <RowText
                              name={name}
                              detail={`${label.folder} · ${formatBytes(entry.size)} · ${formatDate(deletedAt)}`}
                            />
                          </DataTableCell>
                        ) : (
                          <>
                            <TruncatedCell title={label.name ?? undefined}>{name}</TruncatedCell>
                            <TruncatedCell
                              title={label.folder}
                              className="text-muted-foreground text-xs"
                            >
                              {label.folder}
                            </TruncatedCell>
                            <DataTableCell className="text-right text-muted-foreground text-xs">
                              {formatBytes(entry.size)}
                            </DataTableCell>
                            <DataTableCell
                              className="text-muted-foreground text-xs"
                              title={deletedAt.toLocaleString()}
                            >
                              {formatDate(deletedAt)}
                            </DataTableCell>
                          </>
                        )}
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            )}
            {trash.data?.truncated === true && (
              <p className="border-border/60 border-b px-3 py-2 text-muted-foreground text-xs">
                Showing the first {entries.length} items.
              </p>
            )}
          </>
        )}
      </PageBody>

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
