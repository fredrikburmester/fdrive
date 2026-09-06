"use client";

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

export interface SaveConflictDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOverwrite: () => void;
  readonly onReload: () => void;
  readonly pending?: boolean;
}

/**
 * Shown when a save's pre-flight `stat` finds the file changed since it
 * was loaded. "Overwrite" saves anyway, discarding whatever changed on
 * disk; "Reload file" discards the local edits and loads the current
 * disk contents instead; "Cancel" just closes the dialog and leaves the
 * document as it was, still unsaved.
 */
export function SaveConflictDialog({
  open,
  onOpenChange,
  onOverwrite,
  onReload,
  pending = false,
}: SaveConflictDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>This file changed on disk</AlertDialogTitle>
          <AlertDialogDescription>
            Someone (or something) else changed this file since it was opened here. Overwrite their
            changes with yours, reload the file and lose your edits, or cancel and keep editing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="outline" onClick={onReload} disabled={pending}>
            Reload file
          </Button>
          <AlertDialogAction onClick={onOverwrite} disabled={pending}>
            Overwrite
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
