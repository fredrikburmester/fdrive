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

/** Shown wherever Office is about to be turned on while fdrive has no server address. */
export const OFFICE_ADDRESS_NOTE =
  "Set the fdrive server address first: the editor opens documents through it.";
export const OFFICE_CLOSE_NOTE =
  "Close open documents before disabling the editor to avoid interrupting unsaved work.";
export const OFFICE_GUIDE_URL =
  "https://github.com/fredrikburmester/fdrive/blob/main/docs/OFFICE.md";

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
  /**
   * Saves Office on or off at once, with everything else as it was last saved. An unsaved
   * editing draft is dropped: the Office sheet's switch works like a feature's.
   */
  saveEnabled: (enabled: boolean) => void;
  reset: () => void;
  commit: (input: OfficeSettings, onSaved?: () => void) => void;
}

/**
 * The Office settings draft shared by the wizard's card and the Office
 * sheet: one place that knows how a draft merges with the polled record and
 * what a save sends. Editors are fdrive's users, so a name no user has any
 * more (one removed since it was saved) is left out of what a save sends.
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
  const withKnownEditors = (record: OfficeSettings): OfficeSettings =>
    known
      ? { ...record, editorUsernames: record.editorUsernames.filter((name) => known.has(name)) }
      : record;
  const values = stored ? withKnownEditors(stored) : stored;
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
    saveEnabled: (enabled: boolean) => {
      if (!saved) return;
      const record = withKnownEditors(saved);
      // Editing with no editor left (the last one is no longer a user) cannot be saved, and
      // means view-only for everyone already, so the switch saves it as that.
      const input = OfficeSettingsUpdateRequest.safeParse({
        ...record,
        enabled,
        editingEnabled: record.editingEnabled && record.editorUsernames.length > 0,
      });
      if (input.success) update.mutate(input.data, { onSuccess: reset });
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

export const OFFICE_EDITORS_LABEL = "Users allowed to edit";
export const OFFICE_EDITORS_NOTE =
  "Everyone else opens documents view-only, and saves still need write access.";
export const OFFICE_EDITING_NOTE =
  "When off, all documents open for viewing. When on, only the users you choose can edit.";

/**
 * fdrive's users as checkboxes: the ones checked may edit documents. One column in the
 * walkthrough's card; in the Office sheet they fill the row, several to a line.
 */
export function OfficeEditorChoices({
  draft,
  values,
  disabled = false,
  label,
}: {
  draft: OfficeSettingsDraft;
  values: OfficeSettings;
  disabled?: boolean;
  /** Names the group where no legend does. */
  label?: string;
}) {
  const { users } = draft;
  if (users.isError)
    return <SystemErrorState error={users.error} onRetry={() => void users.refetch()} />;
  if (users.data === undefined)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading users…
      </p>
    );
  return (
    <FieldGroup
      data-slot="checkbox-group"
      role={label === undefined ? undefined : "group"}
      aria-label={label}
      className="sheet:grid sheet:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] sheet:gap-x-6 sheet:gap-y-3 sheet:max-md:gap-y-0"
    >
      {users.data.users.map((user) => (
        <Field key={user.username} orientation="horizontal" className="sheet:max-md:min-h-11">
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
  );
}

/**
 * The Office settings as a form, without the surrounding card or its Save
 * button: what the walkthrough's card shows. The Office sheet lays the same
 * settings out as rows.
 */
function OfficeSettingsFields({
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
              {OFFICE_ADDRESS_NOTE}
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
          <FieldDescription>{OFFICE_EDITING_NOTE}</FieldDescription>
          {values.editingEnabled ? (
            <FieldSet>
              <FieldLegend variant="label">{OFFICE_EDITORS_LABEL}</FieldLegend>
              <FieldDescription>{OFFICE_EDITORS_NOTE}</FieldDescription>
              <OfficeEditorChoices draft={draft} values={values} disabled={disabled} />
            </FieldSet>
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
            <p className="text-sm text-muted-foreground">{OFFICE_CLOSE_NOTE}</p>
          ) : null}
          <a
            className="block text-sm underline"
            href={OFFICE_GUIDE_URL}
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
