"use client";

import { UnlinkIdentityRequest } from "@fdrive/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
  const [currentPassword, setCurrentPassword] = useState("");
  const [currentOtp, setCurrentOtp] = useState("");
  const request = {
    currentCredential: { password: currentPassword, ...(currentOtp ? { otp: currentOtp } : {}) },
  };
  const valid = currentPassword.length > 0 && UnlinkIdentityRequest.safeParse(request).success;
  function close() {
    setCurrentPassword("");
    setCurrentOtp("");
    actions.resetError();
    onClose();
  }
  async function submit() {
    if (!identity || !valid || actions.pending) return;
    const parsed = UnlinkIdentityRequest.parse(request);
    setCurrentPassword("");
    setCurrentOtp("");
    if (await actions.unlink(identity.id, parsed)) onClose();
  }
  return (
    <Dialog
      open={identity !== null}
      onOpenChange={(open) => {
        if (!open && !actions.pending) close();
      }}
    >
      <DialogContent showCloseButton={!actions.pending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove {identity?.username}?</DialogTitle>
            <DialogDescription>
              {identity?.providerLabel}. Files remain on the server. This login becomes a separate
              account and its sessions are signed out.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="unlink-current-password">Your current password</FieldLabel>
              <Input
                id="unlink-current-password"
                type="password"
                autoComplete="current-password"
                maxLength={4096}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={actions.pending}
                required
              />
              <FieldDescription>
                The password of the login you are signed in with, to confirm this change.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="unlink-current-otp">Your one-time code</FieldLabel>
              <Input
                id="unlink-current-otp"
                autoComplete="one-time-code"
                maxLength={32}
                value={currentOtp}
                onChange={(event) => setCurrentOtp(event.target.value)}
                disabled={actions.pending}
              />
              <FieldDescription>
                Optional. Enter it if your current login uses two-factor authentication.
              </FieldDescription>
            </Field>
            {actions.error ? <FieldError>{actions.error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={actions.pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={actions.pending || !valid}>
              {actions.pending ? "Removing…" : "Remove login"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
