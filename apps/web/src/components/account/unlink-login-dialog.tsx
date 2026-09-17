"use client";

import { UnlinkIdentityRequest } from "@fdrive/contracts";
import { useState } from "react";
import { ProviderFieldInputs } from "@/components/identity/provider-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError, FieldGroup } from "@/components/ui/field";
import type { AccountIdentity } from "@/lib/account/identities";
import { useIdentityActions } from "@/lib/account/use-identities";
import { useMe } from "@/lib/api/auth-queries";
import { useProviders } from "@/lib/api/provider-queries";
import {
  buildCredential,
  confirmationFieldsFor,
  credentialComplete,
  credentialFieldsFor,
} from "@/lib/auth/login-model";
import { loginDisplay } from "@/lib/identity/login-display";

const EMPTY_VALUES: Readonly<Record<string, string>> = {};

/**
 * Removes a login from the account after the person confirms the login
 * they are signed in with, using that login's provider's secret fields.
 */
export function UnlinkLoginDialog({
  identity,
  onClose,
}: {
  identity: AccountIdentity | null;
  onClose: () => void;
}) {
  const { data: me } = useMe();
  const { data: providerList } = useProviders();
  const actions = useIdentityActions();
  const [current, setCurrent] = useState(EMPTY_VALUES);
  const display = identity ? loginDisplay(identity) : undefined;

  const activeIdentity = me?.identities.find((candidate) => candidate.id === me.activeIdentityId);
  const activeProvider = providerList?.providers.find(
    (candidate) => candidate.id === activeIdentity?.providerId,
  );
  const confirmFields = confirmationFieldsFor(credentialFieldsFor(activeProvider));
  const request = { currentCredential: buildCredential(confirmFields, current) };
  const valid =
    credentialComplete(confirmFields, current) && UnlinkIdentityRequest.safeParse(request).success;

  function close() {
    setCurrent(EMPTY_VALUES);
    actions.resetError();
    onClose();
  }
  async function submit() {
    if (!identity || !valid || actions.pending) return;
    const parsed = UnlinkIdentityRequest.parse(request);
    setCurrent(EMPTY_VALUES);
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
            <DialogTitle>Remove {display?.title}?</DialogTitle>
            <DialogDescription>
              {display?.detail}. Files remain on the server. This login becomes a separate account
              and its sessions are signed out.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <ProviderFieldInputs
              fields={confirmFields}
              values={current}
              onChange={(name, value) => setCurrent((prev) => ({ ...prev, [name]: value }))}
              idPrefix="unlink-current"
              disabled={actions.pending}
            />
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
