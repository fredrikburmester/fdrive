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

export interface DeleteDialogProps {
  entries: readonly FsEntry[];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending?: boolean;
}

/** Confirms deleting one or more entries, listing how many will be removed. */
export function DeleteDialog({
  entries,
  onOpenChange,
  onConfirm,
  pending = false,
}: DeleteDialogProps) {
  const count = entries.length;
  const description =
    count === 1 && entries[0] !== undefined
      ? `"${entries[0].name}" will be permanently deleted.`
      : `${count} items will be permanently deleted.`;

  return (
    <AlertDialog open={count > 0} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {count === 1 ? "item" : "items"}?</AlertDialogTitle>
          <AlertDialogDescription>{description} This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onConfirm();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
