"use client";

import { type OfficeSettings, OfficeSettingsUpdateRequest } from "@fdrive/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { useSystemOffice, useUpdateOfficeSettings } from "@/lib/api/office-settings-queries";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import { useAdminUsers } from "@/lib/api/system-queries";
import { SystemErrorState } from "./system-error-state";
import { SystemSection } from "./system-section";

/** Human name of the configured Office product. */
export function officeProductName(product: string | undefined): string {
  return product === "collabora" ? "Collabora" : "ONLYOFFICE";
}

export interface OfficeSettingsDraft {
  query: ReturnType<typeof useSystemOffice>;
  update: ReturnType<typeof useUpdateOfficeSettings>;
  /** fdrive's users, whom editors are chosen from. */
  users: ReturnType<typeof useAdminUsers>;
  /** "ONLYOFFICE" or "Collabora". */
  product: string;
  /** The saved record, `undefined` until the query resolves. */
  saved: OfficeSettings | undefined;
  /** The record as edited, ready to submit. */
  values: OfficeSettings | undefined;
  /** `values` parsed against the update contract. */
  parsed: ReturnType<typeof OfficeSettingsUpdateRequest.safeParse>;
  /** True once the owner has touched any field. */
  dirty: boolean;
  /** No server address is set, so the API would refuse to enable Office. */
  addressMissing: boolean;
  change: (patch: Partial<OfficeSettings>) => void;
  /** Adds `username` to the editors, or takes them off. */
  setEditor: (username: string, editor: boolean) => void;
  /** Turning Office off also drops the unsaved editing draft. */
  setEnabled: (enabled: boolean) => void;
  reset: () => void;
  commit: (input: OfficeSettings, onSaved?: () => void) => void;
}

/**
 * The Office settings draft shared by the wizard's card, the Features
 * page's Office card, and the Office page's settings sheet: one place that
 * knows how a draft merges with the polled record and what a save sends.
 * Editors are fdrive's users, so a name no user has any more (one removed
 * since it was saved) is left out of what a save sends.
 */
export function useOfficeSettingsDraft(): OfficeSettingsDraft {
  const query = useSystemOffice();
  const address = useSystemPublicUrl();
  const update = useUpdateOfficeSettings();
  const users = useAdminUsers();
  const [draft, setDraft] = useState<OfficeSettings | null>(null);
  const saved = query.data?.configuration;
  const stored = draft ?? saved;
  const known = users.data ? new Set(users.data.users.map((user) => user.username)) : null;
  const values =
    stored && known
      ? { ...stored, editorUsernames: stored.editorUsernames.filter((name) => known.has(name)) }
      : stored;
  // The editor is told fdrive lives at the server address; without one the
  // api refuses to enable Office, so say so before the owner tries.
  const addressMissing = address.data !== undefined && address.data.url === null;

  function change(patch: Partial<OfficeSettings>) {
    if (values) setDraft({ ...values, ...patch });
  }

  function reset() {
    setDraft(null);
  }

  return {
    query,
    update,
    users,
    product: officeProductName(query.data?.product),
    saved,
    values,
    parsed: OfficeSettingsUpdateRequest.safeParse(values),
    dirty: draft !== null,
    addressMissing,
    change,
    setEditor: (username: string, editor: boolean) => {
      if (!values) return;
      const editors = values.editorUsernames.filter((name) => name !== username);
      change({ editorUsernames: editor ? [...editors, username] : editors });
    },
    setEnabled: (enabled: boolean) => {
      if (enabled) {
        change({ enabled });
        return;
      }
      setDraft(saved ? { ...saved, enabled: false } : null);
    },
    reset,
    commit: (input: OfficeSettings, onSaved?: () => void) => {
      update.mutate(input, {
        onSuccess: () => {
          reset();
          onSaved?.();
        },
      });
    },
  };
}

/** fdrive's users as checkboxes: the ones checked may edit documents. */
function OfficeEditorsField({
  draft,
  values,
  disabled,
}: {
  draft: OfficeSettingsDraft;
  values: OfficeSettings;
  disabled: boolean;
}) {
  const { users } = draft;
  return (
    <FieldSet>
      <FieldLegend variant="label">Users allowed to edit</FieldLegend>
      <FieldDescription>
        Everyone else opens documents view-only, and saves still need write access.
      </FieldDescription>
      {users.isError ? (
        <SystemErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading users…
        </p>
      ) : (
        <FieldGroup data-slot="checkbox-group">
          {users.data.users.map((user) => (
            <Field key={user.username} orientation="horizontal">
              <Checkbox
                id={`office-editor-${user.username}`}
                checked={values.editorUsernames.includes(user.username)}
                disabled={disabled}
                onCheckedChange={(checked) => draft.setEditor(user.username, checked)}
              />
              <FieldLabel htmlFor={`office-editor-${user.username}`} className="font-normal">
                {user.username}
              </FieldLabel>
            </Field>
          ))}
        </FieldGroup>
      )}
    </FieldSet>
  );
}

/**
 * The Office settings controls themselves, without the surrounding card or
 * its Save button: shared by the onboarding card and the Office page's
 * settings sheet.
 */
export function OfficeSettingsFields({
  draft,
  disabled = false,
}: {
  draft: OfficeSettingsDraft;
  disabled?: boolean;
}) {
  const { product, values, parsed, dirty, addressMissing } = draft;
  if (!values) return null;
  return (
    <>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="enable-office">Enable {product}</FieldLabel>
        <Switch
          id="enable-office"
          checked={values.enabled}
          disabled={disabled}
          onCheckedChange={draft.setEnabled}
        />
      </Field>
      <FieldDescription>
        Documents stay in your storage. No processing storage mount is needed. The bundled editor
        uses additional memory while enabled.
      </FieldDescription>
      {values.enabled ? (
        <>
          {addressMissing ? (
            <p role="alert" className="text-sm text-destructive">
              Set the fdrive server address first: the editor opens documents through it.
            </p>
          ) : null}
          {dirty && !parsed.success ? (
            <p role="alert" className="text-sm text-destructive">
              When editing is enabled, choose at least one user.
            </p>
          ) : null}
          <Field orientation="horizontal">
            <FieldLabel htmlFor="office-editing">Allow document editing</FieldLabel>
            <Switch
              id="office-editing"
              checked={values.editingEnabled}
              disabled={disabled}
              onCheckedChange={(editingEnabled) => draft.change({ editingEnabled })}
            />
          </Field>
          <FieldDescription>
            When off, all documents open for viewing. When on, only the users you choose can edit.
          </FieldDescription>
          {values.editingEnabled ? (
            <OfficeEditorsField draft={draft} values={values} disabled={disabled} />
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function OfficeSettingsCard({
  onContinue,
  disabled = false,
}: {
  onContinue?: () => void;
  disabled?: boolean;
}) {
  const draft = useOfficeSettingsDraft();
  const { query, update, product, saved, values, parsed, addressMissing } = draft;
  const busy = disabled || update.isPending;

  function save(skip = false) {
    if (!saved) return;
    if (skip && !saved.enabled) {
      onContinue?.();
      return;
    }
    const input = OfficeSettingsUpdateRequest.safeParse(
      skip ? { ...saved, enabled: false } : values,
    );
    if (!input.success) return;
    draft.commit(input.data, onContinue);
  }

  return (
    <SystemSection
      title={product}
      description="Open documents, spreadsheets, and presentations in your browser."
      padded
      contentClassName="gap-4"
    >
      {query.isError ? (
        <>
          <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
          {onContinue ? (
            <Button variant="outline" disabled={busy} onClick={onContinue}>
              Continue without changing {product}
            </Button>
          ) : null}
        </>
      ) : values ? (
        <>
          <OfficeSettingsFields draft={draft} disabled={busy} />
          {saved?.enabled ? (
            <p role="status" className="text-sm text-muted-foreground">
              {query.data?.status === "ready"
                ? `${product} is ready.`
                : query.data?.status === "starting"
                  ? `${product} is starting. You can finish setup while it starts.`
                  : `Unable to reach ${product}. Check its container and the setup guide.`}
            </p>
          ) : null}
          {saved?.enabled ? (
            <p className="text-sm text-muted-foreground">
              Close open documents before disabling the editor to avoid interrupting unsaved work.
            </p>
          ) : null}
          <a
            className="block text-sm underline"
            href="https://github.com/fredrikburmester/fdrive/blob/main/docs/OFFICE.md"
            target="_blank"
            rel="noreferrer"
          >
            Office setup instructions
          </a>
          {update.isError ? (
            <div role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
              {describeApiError(update.error)}
              <Button
                variant="link"
                onClick={() => {
                  draft.reset();
                  update.reset();
                  void query.refetch();
                }}
              >
                Reload saved settings
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {onContinue ? (
              <Button variant="outline" disabled={busy} onClick={() => save(true)}>
                Skip {product}
              </Button>
            ) : null}
            <Button
              disabled={busy || !parsed.success || (values.enabled && addressMissing)}
              onClick={() => save()}
            >
              {update.isPending
                ? "Saving…"
                : onContinue
                  ? "Save and continue"
                  : `Save ${product} settings`}
            </Button>
          </div>
        </>
      ) : (
        <p role="status">Loading Office settings…</p>
      )}
    </SystemSection>
  );
}

export function OfficeReview() {
  const query = useSystemOffice();
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span>{officeProductName(query.data?.product)}</span>
      <span>
        {query.data
          ? query.data.configuration.enabled
            ? "Enabled"
            : "Off"
          : query.isError
            ? "Status unavailable"
            : "Loading…"}
      </span>
    </div>
  );
}
