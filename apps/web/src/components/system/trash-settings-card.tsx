"use client";

import {
  type TrashSettings,
  TrashSettingsUpdateRequest,
  type TrashStrategy,
} from "@fdrive/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { useSystemTrash, useUpdateTrashSettings } from "@/lib/api/trash-settings-queries";
import { SystemErrorState } from "./system-error-state";
import { SystemSection } from "./system-section";

/**
 * The card's copy per Trash strategy. `native` connects fdrive to a recycle
 * bin the backend (SFTPGo's Event Manager rule) fills itself; `move` has
 * fdrive move deleted files into the folder on the server; `none` is a
 * provider without any Trash, which the switch cannot turn on.
 */
const COPY: Record<
  TrashStrategy,
  { description: string; requirement: string; folder: string; disabling: string }
> = {
  native: {
    description: "Restore deleted files from your SFTPGo recycle bin.",
    requirement:
      "Requires SFTPGo recycle-bin rules. No processing worker or local storage mount is needed.",
    folder: "The folder within each user's SFTPGo home; it must match the recycle-bin rule.",
    disabling:
      "Disabling this integration does not change SFTPGo rules or delete items already in Trash.",
  },
  move: {
    description: "Restore deleted files that fdrive moved into a recycle folder.",
    requirement:
      "fdrive moves deleted files into this folder on the storage server itself. No server rules, processing worker or local storage mount is needed.",
    folder:
      "The folder within each user's home on this server; fdrive creates it on the first delete.",
    disabling:
      "Disabling this makes deletes permanent again; it does not delete items already in Trash.",
  },
  none: {
    description: "This storage server has no Trash.",
    requirement: "Deleting a file on this server removes it permanently.",
    folder: "",
    disabling: "",
  },
};

/** The storage server a Trash form edits. */
export interface TrashProviderRef {
  readonly id: string;
  readonly label: string;
}

export interface TrashSettingsFormProps {
  provider: TrashProviderRef;
  /** Walkthrough only: advance after saving, or skip without enabling. */
  onContinue?: () => void;
  disabled?: boolean;
}

/**
 * The Trash controls of one storage server: the settings live per provider
 * row, so the form is rendered once per server on System > Storage and once
 * for the login being set up in the walkthrough. Field ids carry the
 * provider id so several forms can share a page.
 */
export function TrashSettingsForm({
  provider,
  onContinue,
  disabled = false,
}: TrashSettingsFormProps) {
  const query = useSystemTrash(provider.id);
  const update = useUpdateTrashSettings();
  const [draft, setDraft] = useState<TrashSettings | null>(null);
  const [retention, setRetention] = useState<string | null>(null);
  const values = draft ?? query.data;
  const busy = disabled || update.isPending;
  const retentionInput = retention ?? values?.retentionHours?.toString() ?? "";
  const input = values
    ? { ...values, retentionHours: retentionInput.trim() === "" ? null : Number(retentionInput) }
    : null;
  const valid = TrashSettingsUpdateRequest.safeParse(input).success;
  const copy = COPY[values?.strategy ?? "native"];
  const change = (patch: Partial<TrashSettings>) => {
    if (values) setDraft({ ...values, ...patch });
  };
  function save(skip = false) {
    if (!values) return;
    if (skip && !query.data?.enabled) {
      onContinue?.();
      return;
    }
    const next = skip ? { ...query.data, enabled: false } : input;
    const parsed = TrashSettingsUpdateRequest.safeParse(next);
    if (!parsed.success) return;
    update.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(null);
        setRetention(null);
        onContinue?.();
      },
    });
  }
  const field = (name: string) => `${name}-${provider.id}`;
  return (
    <>
      <p className="text-sm text-muted-foreground">{copy.description}</p>
      {query.isError ? (
        <>
          <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
          {onContinue ? (
            <Button variant="outline" disabled={busy} onClick={onContinue}>
              Continue without changing Trash
            </Button>
          ) : null}
        </>
      ) : values ? (
        <>
          <Field orientation="horizontal">
            <FieldLabel htmlFor={field("enable-trash")}>Enable Trash</FieldLabel>
            <Switch
              id={field("enable-trash")}
              checked={values.enabled}
              disabled={busy || values.strategy === "none"}
              onCheckedChange={(enabled) => {
                if (enabled) change({ enabled });
                else {
                  setDraft(query.data ? { ...query.data, enabled: false } : null);
                  setRetention(null);
                }
              }}
            />
          </Field>
          <FieldDescription>{copy.requirement}</FieldDescription>
          {values.enabled ? (
            <>
              {values.strategy === "native" ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Configure and test SFTPGo's pre-delete rule first. Turning this on only connects
                    fdrive to that recycle bin; it does not create the rule.
                  </p>
                  <a
                    className="text-sm underline"
                    href="https://github.com/fredrikburmester/fdrive-web/blob/main/docs/TRASH.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Trash setup instructions
                  </a>
                </>
              ) : null}
              <Field>
                <FieldLabel htmlFor={field("trash-path")}>Trash folder</FieldLabel>
                <Input
                  id={field("trash-path")}
                  value={values.path}
                  disabled={busy}
                  onChange={(event) => change({ path: event.target.value, rulesConfirmed: false })}
                />
                <FieldDescription>{copy.folder}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={field("trash-retention")}>
                  Retention in hours (optional)
                </FieldLabel>
                <Input
                  id={field("trash-retention")}
                  type="number"
                  min={1}
                  step={1}
                  value={retentionInput}
                  disabled={busy}
                  onChange={(event) => setRetention(event.target.value)}
                />
                <FieldDescription>
                  {values.strategy === "native" ? "Match your SFTPGo cleanup schedule. " : ""}
                  This value is informational; fdrive does not delete old items automatically.
                </FieldDescription>
              </Field>
              {values.strategy === "native" ? (
                <Field orientation="horizontal">
                  <Checkbox
                    id={field("trash-rules")}
                    checked={values.rulesConfirmed}
                    disabled={busy}
                    onCheckedChange={(rulesConfirmed) => change({ rulesConfirmed })}
                  />
                  <FieldLabel htmlFor={field("trash-rules")}>
                    I configured and tested SFTPGo's recycle-bin rule for this folder.
                  </FieldLabel>
                </Field>
              ) : null}
            </>
          ) : null}
          {copy.disabling ? (
            <p className="text-sm text-muted-foreground">{copy.disabling}</p>
          ) : null}
          {update.isError ? (
            <div role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
              {describeApiError(update.error)}
              <Button
                variant="link"
                onClick={() => {
                  setDraft(null);
                  setRetention(null);
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
                Skip Trash
              </Button>
            ) : null}
            <Button disabled={busy || !valid} onClick={() => save()}>
              {update.isPending
                ? "Saving…"
                : onContinue
                  ? "Save and continue"
                  : "Save Trash settings"}
            </Button>
          </div>
        </>
      ) : (
        <p role="status">Loading Trash settings…</p>
      )}
    </>
  );
}

/** The walkthrough's Trash step: one server's form inside a titled card. */
export function TrashSettingsCard(props: TrashSettingsFormProps) {
  return (
    <SystemSection
      title="Trash"
      description={`For ${props.provider.label}. Every storage server keeps its own Trash settings under System > Storage.`}
      contentClassName="gap-4"
    >
      <TrashSettingsForm {...props} />
    </SystemSection>
  );
}

export function TrashReview({ provider }: { provider: TrashProviderRef }) {
  const query = useSystemTrash(provider.id);
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span>Trash · {provider.label}</span>
      <span>
        {query.data
          ? query.data.enabled
            ? "Enabled"
            : "Off"
          : query.isError
            ? "Status unavailable"
            : "Loading…"}
      </span>
    </div>
  );
}
