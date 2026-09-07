"use client";

import type { FsEntry } from "@fdrive/contracts";
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
import { deleteDialogCopy, type TrashAvailability } from "@/lib/trash/format";

export interface DeleteDialogProps {
  entries: readonly FsEntry[];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending?: boolean;
  /**
   * Whether the active identity's storage provider exposes a trash. `null`
   * (the default) and `{ available: false }` both render the permanent
   * "Delete" copy; `{ available: true, retentionHours }` renders the
   * non-destructive "Move to Trash" copy, adding the retention sentence
   * when `retentionHours` is configured.
   */
  trash?: TrashAvailability | null;
}

/** Confirms deleting (or, with a trash configured, moving to Trash) one or more entries. */
export function DeleteDialog({
  entries,
  onOpenChange,
  onConfirm,
  pending = false,
  trash = null,
}: DeleteDialogProps) {
  const count = entries.length;
  const copy = deleteDialogCopy(
    entries.map((entry) => entry.name),
    trash,
  );
  const movingToTrash = trash?.available === true;

  return (
    <AlertDialog open={count > 0} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={movingToTrash ? "default" : "destructive"}
            disabled={pending}
            onClick={() => {
              onConfirm();
            }}
          >
            {copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
