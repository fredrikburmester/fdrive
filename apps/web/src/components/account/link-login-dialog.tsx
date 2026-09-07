"use client";

import { LinkIdentityRequest } from "@fdrive/contracts";
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
import { useIdentityActions } from "@/lib/account/use-identities";

export function LinkLoginDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const actions = useIdentityActions();
  const valid = LinkIdentityRequest.safeParse({
    username,
    password,
    ...(otp ? { otp } : {}),
  }).success;

  function close(next: boolean) {
    if (actions.pending) return;
    setPassword("");
    setOtp("");
    setUsername("");
    actions.resetError();
    onOpenChange(next);
  }

  async function submit() {
    const parsed = LinkIdentityRequest.safeParse({ username, password, ...(otp ? { otp } : {}) });
    if (!parsed.success || actions.pending) return;
    setPassword("");
    setOtp("");
    if (await actions.link(parsed.data)) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={!actions.pending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Link login</DialogTitle>
            <DialogDescription>
              Add another SFTPGo login to this account and make it active.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="link-username">Username</FieldLabel>
              <Input
                id="link-username"
                autoComplete="username"
                maxLength={255}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={actions.pending}
                required
              />
              <FieldDescription>The login on the connected SFTPGo server.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="link-password">Password</FieldLabel>
              <Input
                id="link-password"
                type="password"
                autoComplete="current-password"
                maxLength={4096}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={actions.pending}
                required
              />
              <FieldDescription>Used to verify that you own this login.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="link-otp">One-time code</FieldLabel>
              <Input
                id="link-otp"
                autoComplete="one-time-code"
                maxLength={32}
                value={otp}
                onChange={(event) => setOtp(event.target.value)}
                disabled={actions.pending}
              />
              <FieldDescription>
                Optional. Enter it if this login uses two-factor authentication.
              </FieldDescription>
            </Field>
            {actions.error ? <FieldError>{actions.error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={!valid || actions.pending}>
              {actions.pending ? "Linking…" : "Link login"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
