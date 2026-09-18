"use client";

import { LinkIdentityRequest } from "@fdrive/contracts";
import { useState } from "react";
import { ProviderFieldInputs } from "@/components/identity/provider-fields";
import { ProviderPicker } from "@/components/identity/provider-picker";
import { StorageNote } from "@/components/identity/storage-note";
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
import { useIdentityActions } from "@/lib/account/use-identities";
import { useMe } from "@/lib/api/auth-queries";
import { useProviders } from "@/lib/api/provider-queries";
import {
  buildCredential,
  confirmationFieldsFor,
  credentialComplete,
  credentialFieldsFor,
  selectProvider,
} from "@/lib/auth/login-model";

const EMPTY_VALUES: Readonly<Record<string, string>> = {};

/**
 * Adds another login to the account. The new login's fields come from the
 * chosen provider (a picker appears when more than one is enabled); the
 * confirmation fields come from the provider of the login the person is
 * signed in with, since that is the login being vouched for.
 */
export function LinkLoginDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: me } = useMe();
  const { data: providerList } = useProviders();
  const providers = providerList?.providers ?? [];
  const [providerId, setProviderId] = useState<string | null>(null);
  const [values, setValues] = useState(EMPTY_VALUES);
  const [current, setCurrent] = useState(EMPTY_VALUES);
  const actions = useIdentityActions();

  const provider = selectProvider(providers, providerId);
  const fields = credentialFieldsFor(provider);
  const activeIdentity = me?.identities.find((identity) => identity.id === me.activeIdentityId);
  const activeProvider = providers.find((candidate) => candidate.id === activeIdentity?.providerId);
  const confirmFields = confirmationFieldsFor(credentialFieldsFor(activeProvider));

  function request() {
    return {
      ...(provider === undefined ? {} : { providerId: provider.id }),
      credential: buildCredential(fields, values),
      currentCredential: buildCredential(confirmFields, current),
    };
  }
  const valid =
    credentialComplete(fields, values) &&
    credentialComplete(confirmFields, current) &&
    LinkIdentityRequest.safeParse(request()).success;

  function clear() {
    setValues(EMPTY_VALUES);
    setCurrent(EMPTY_VALUES);
  }

  function close(next: boolean) {
    if (actions.pending) return;
    clear();
    setProviderId(null);
    actions.resetError();
    onOpenChange(next);
  }

  async function submit() {
    const parsed = LinkIdentityRequest.safeParse(request());
    if (!parsed.success || actions.pending) return;
    clear();
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
            <DialogTitle>Add login</DialogTitle>
            <DialogDescription>
              Add another login to this account and make it active.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            {providers.length > 1 && provider !== undefined && (
              <ProviderPicker
                id="link-provider"
                providers={providers}
                value={provider.id}
                onChange={(id) => {
                  setProviderId(id);
                  setValues(EMPTY_VALUES);
                }}
                disabled={actions.pending}
              />
            )}
            {providers.length > 1 ? null : <StorageNote capabilities={provider?.capabilities} />}
            <ProviderFieldInputs
              key={provider?.id ?? "default"}
              fields={fields}
              values={values}
              onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
              idPrefix="link"
              disabled={actions.pending}
            />
            <ProviderFieldInputs
              fields={confirmFields}
              values={current}
              onChange={(name, value) => setCurrent((prev) => ({ ...prev, [name]: value }))}
              idPrefix="link-current"
              disabled={actions.pending}
            />
            {actions.error ? <FieldError>{actions.error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={!valid || actions.pending}>
              {actions.pending ? "Adding…" : "Add login"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
