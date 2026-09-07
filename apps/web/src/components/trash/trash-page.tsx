"use client";

import type { TrashEntry } from "@fdrive/contracts";
import { joinPath } from "@fdrive/core";
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
import { describeFsError } from "@/lib/files/queries";
import { formatBytes, formatDate } from "@/lib/format";
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
  useTrashStatus,
} from "@/lib/trash/queries";

/** What the confirmation dialog is asking about: permanently deleting the
 * given selection, or emptying the whole trash. */
type ConfirmAction =
  | { readonly kind: "purge"; readonly ids: readonly string[] }
  | { readonly kind: "empty" };

/** The trash listing at `/trash`: restore, restore-to-a-different-folder,
 * permanent delete, and empty, plus loading/empty/error states. */
export function TrashPage() {
  const status = useTrashStatus();
  const trash = useTrash();
  const restore = useTrashRestore();
  const purge = useTrashPurge();
  const emptyTrash = useTrashEmpty();

  const entries = trash.data?.entries ?? [];
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
    toast.error(restoreConflictMessage(entry.name), {
      action: { label: "Restore to…", onClick: () => setRestoreTargetEntry(entry) },
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

  function handleRestoreToConfirm(folder: string) {
    const entry = restoreTargetEntry;
    setRestoreTargetEntry(null);
    if (entry === null) {
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

  const note = retentionNote(status.data?.retentionHours ?? null);
  const helperText = `Files and folders moved to Trash from Files show up here until you restore or permanently delete them.${note ? ` ${note}` : ""}`;

  return (
    <>
      <PageHeader breadcrumbs={<span className="font-medium">Trash</span>} />
      <main className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
          <p className="mt-1 text-sm text-muted-foreground">{helperText}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selected.size === 0 || restore.isPending}
            onClick={handleRestoreSelected}
          >
            Restore
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
            Restore to…
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
            description="Items you move to Trash from Files show up here until you restore or permanently delete them."
          />
        ) : (
          <>
            <Table>
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
                  return (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(entry.id)}
                          onCheckedChange={(checked) => toggleOne(entry.id, checked)}
                          aria-label={`Select ${entry.name}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{entry.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {originalFolderLabel(entry.originalPath)}
                      </TableCell>
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
