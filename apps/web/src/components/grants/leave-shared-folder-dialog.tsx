"use client";

import type { ReceivedGrant } from "@fdrive/contracts";
import { toast } from "sonner";
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
import { describeGrantError } from "@/lib/grants/format";
import { useLeaveGrant } from "@/lib/grants/queries";

/**
 * Confirms leaving a folder someone shares with the active login. Nothing in
 * the folder changes; it only leaves this login's `Shared with me`.
 */
export function LeaveSharedFolderDialog({
  grant,
  onClose,
}: {
  grant: ReceivedGrant | null;
  onClose: () => void;
}) {
  const leave = useLeaveGrant();

  function confirm() {
    if (grant === null) return;
    const { id, name } = grant;
    leave.mutate(id, {
      onSuccess: () => toast.success(`Left ${name}.`),
      onError: (error) => toast.error(describeGrantError(error)),
    });
    onClose();
  }

  return (
    <AlertDialog open={grant !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* Keep the confirmation copy stable while the dialog exits. */}
      {grant && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {grant.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from Shared with me. Nothing in it changes, and {grant.owner} can share
              it with you again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirm}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
