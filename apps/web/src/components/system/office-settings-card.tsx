"use client";

import { type OfficeSettings, OfficeSettingsUpdateRequest } from "@fdrive/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { describeApiError } from "@/lib/api/errors";
import { useSystemOffice, useUpdateOfficeSettings } from "@/lib/api/office-settings-queries";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import { SystemErrorState } from "./system-error-state";
import { SystemSection } from "./system-section";

/** Human name of the configured Office product. */
export function officeProductName(product: string | undefined): string {
  return product === "collabora" ? "Collabora" : "ONLYOFFICE";
}

export interface OfficeSettingsDraft {
  query: ReturnType<typeof useSystemOffice>;
  update: ReturnType<typeof useUpdateOfficeSettings>;
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
  /** The saved editor grants belong to a different SFTPGo provider. */
  providerChanged: boolean;
  editingMatchesProvider: boolean;
  editorsText: string | null;
  setEditorsText: (text: string) => void;
  change: (patch: Partial<OfficeSettings>) => void;
  /** Turning Office off also drops the unsaved editing draft. */
  setEnabled: (enabled: boolean) => void;
  reset: () => void;
  commit: (input: OfficeSettings, onSaved?: () => void) => void;
}

/**
 * The Office settings draft shared by the wizard's card, the Features
 * page's Office card, and the Office page's settings sheet: one place that
 * knows how a draft merges with the polled record, when saved editor grants
 * stop applying because the SFTPGo provider changed, and what a save sends.
 */
export function useOfficeSettingsDraft(): OfficeSettingsDraft {
  const query = useSystemOffice();
  const address = useSystemPublicUrl();
  const update = useUpdateOfficeSettings();
  const [draft, setDraft] = useState<OfficeSettings | null>(null);
  const [editorsText, setEditorsText] = useState<string | null>(null);
  const saved = query.data?.configuration;
  const stored = draft ?? saved;
  const providerChanged =
    (stored?.editingEnabled ?? false) && stored?.editingProviderId !== query.data?.activeProviderId;
  const base =
    stored && providerChanged
      ? { ...stored, editingEnabled: false, editingProviderId: null, editorUsernames: [] }
      : stored;
  const values =
    base && editorsText !== null
      ? {
          ...base,
          editorUsernames: editorsText
            .split("\n")
            .map((name) => name.trim())
            .filter(Boolean),
        }
      : base;
  // The editor is told fdrive lives at the server address; without one the
  // api refuses to enable Office, so say so before the owner tries.
  const addressMissing = address.data !== undefined && address.data.url === null;

  function change(patch: Partial<OfficeSettings>) {
    if (values) setDraft({ ...values, ...patch });
  }

  function reset() {
    setDraft(null);
    setEditorsText(null);
  }

  return {
    query,
    update,
    product: officeProductName(query.data?.product),
    saved,
    values,
    parsed: OfficeSettingsUpdateRequest.safeParse(values),
    dirty: draft !== null || editorsText !== null,
    addressMissing,
    providerChanged,
    editingMatchesProvider: values?.editingProviderId === query.data?.activeProviderId,
    editorsText,
    setEditorsText,
    change,
    setEnabled: (enabled: boolean) => {
      if (enabled) {
        change({ enabled });
        return;
      }
      setDraft(saved ? { ...saved, enabled: false } : null);
      setEditorsText(null);
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
  const { product, values, parsed, dirty, addressMissing, providerChanged } = draft;
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
        Documents stay in SFTPGo. No processing storage mount is needed. The bundled editor uses
        additional memory while enabled.
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
              When editing is enabled, enter at least one allowed username.
            </p>
          ) : null}
          {providerChanged ? (
            <p role="status" className="text-sm text-muted-foreground">
              The SFTPGo provider changed. Choose editors again to enable editing for this server.
            </p>
          ) : null}
          <Field orientation="horizontal">
            <FieldLabel htmlFor="office-editing">Allow document editing</FieldLabel>
            <Switch
              id="office-editing"
              checked={values.editingEnabled && draft.editingMatchesProvider}
              disabled={disabled}
              onCheckedChange={(editingEnabled) => {
                if (!draft.editingMatchesProvider) draft.setEditorsText("");
                draft.change({
                  editingEnabled,
                  editingProviderId: draft.query.data?.activeProviderId ?? null,
                  editorUsernames: draft.editingMatchesProvider ? values.editorUsernames : [],
                });
              }}
            />
          </Field>
          <FieldDescription>
            When off, all documents open for viewing. When on, only the users you list below can
            edit.
            {draft.query.data?.activeProviderLabel
              ? ` Editing is granted on ${draft.query.data.activeProviderLabel} only; other storage servers stay view-only.`
              : ""}
          </FieldDescription>
          {values.editingEnabled && draft.editingMatchesProvider ? (
            <Field>
              <FieldLabel htmlFor="office-editors">Users allowed to edit</FieldLabel>
              <Textarea
                id="office-editors"
                disabled={disabled}
                value={draft.editorsText ?? values.editorUsernames.join("\n")}
                onChange={(event) => {
                  draft.change({});
                  draft.setEditorsText(event.target.value);
                }}
              />
              <FieldDescription>
                One SFTPGo username per line. These users can open documents for editing; everyone
                else gets view-only. Being listed here grants no file access — SFTPGo permissions
                still apply to saves.
              </FieldDescription>
            </Field>
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
