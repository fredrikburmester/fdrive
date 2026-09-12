"use client";

import type { FsEntry } from "@fdrive/contracts";
import { Loader2 } from "lucide-react";
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
  /**
   * Whether the delete request is in flight. While it is, the confirm button
   * shows a spinner with progressive copy, Cancel is disabled, and the dialog
   * ignores dismissal so the indicator stays visible for a slow request, such
   * as a large folder or selection; the request itself cannot be cancelled.
   */
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
    <AlertDialog
      open={count > 0}
      onOpenChange={(open) => {
        if (!open && pending) {
          return;
        }
        onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={movingToTrash ? "default" : "destructive"}
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              onConfirm();
            }}
          >
            {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {pending ? copy.pendingLabel : copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
