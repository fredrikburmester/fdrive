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
import { useTrashSettings } from "@/lib/api/trash-settings-queries";
import { deleteDialogCopy } from "@/lib/trash/format";

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
}

/**
 * Confirms moving one or more entries to Trash, saying how long Trash keeps
 * them once that setting has loaded.
 */
export function DeleteDialog({
  entries,
  onOpenChange,
  onConfirm,
  pending = false,
}: DeleteDialogProps) {
  const count = entries.length;
  const retentionDays = useTrashSettings().data?.retentionDays;
  const copy = deleteDialogCopy(
    entries.map((entry) => entry.name),
    retentionDays,
  );

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
