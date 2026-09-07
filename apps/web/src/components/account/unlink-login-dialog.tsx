"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import type { AccountIdentity } from "@/lib/account/identities";
import { useIdentityActions } from "@/lib/account/use-identities";

export function UnlinkLoginDialog({
  identity,
  onClose,
}: {
  identity: AccountIdentity | null;
  onClose: () => void;
}) {
  const actions = useIdentityActions();
  return (
    <Dialog
      open={identity !== null}
      onOpenChange={(open) => {
        if (!open && !actions.pending) {
          actions.resetError();
          onClose();
        }
      }}
    >
      <DialogContent showCloseButton={!actions.pending}>
        <DialogHeader>
          <DialogTitle>Unlink {identity?.username}?</DialogTitle>
          <DialogDescription>
            {identity?.providerLabel}. Files remain on the server. This login becomes a separate
            account and its sessions are signed out.
          </DialogDescription>
        </DialogHeader>
        {actions.error ? <FieldError>{actions.error}</FieldError> : null}
        <DialogFooter>
          <Button variant="outline" disabled={actions.pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={actions.pending || !identity}
            onClick={async () => {
              if (identity && (await actions.unlink(identity.id))) onClose();
            }}
          >
            {actions.pending ? "Unlinking…" : "Unlink login"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
