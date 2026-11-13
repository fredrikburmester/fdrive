"use client";

import {
  type TrashSettings,
  TrashSettingsUpdateRequest,
  type TrashStrategy,
} from "@fdrive/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { useSystemTrash, useUpdateTrashSettings } from "@/lib/api/trash-settings-queries";
import { SystemErrorState } from "./system-error-state";
import { SystemSection } from "./system-section";

interface TrashCopy {
  readonly description: string;
  readonly requirement: string;
  readonly folder: string;
  readonly disabling: string;
}

/** fdrive moves deleted files into a recycle folder on the storage itself. */
const MOVE_COPY: TrashCopy = {
  description: "Restore deleted files that fdrive moved into a recycle folder.",
  requirement:
    "fdrive moves deleted files into this folder on the storage itself. No server rules, processing worker or storage mount is needed.",
  folder:
    "The folder within each user's home on this server; fdrive creates it on the first delete.",
  disabling:
    "Disabling this makes deletes permanent again; it does not delete items already in Trash.",
};

/** A storage row without any Trash, which the switch cannot turn on. */
const NONE_COPY: TrashCopy = {
  description: "This storage has no Trash.",
  requirement: "Deleting a file removes it permanently.",
  folder: "",
  disabling: "",
};

/**
 * The card's copy for the storage's Trash strategy: `none` has no Trash,
 * and every other strategy has fdrive keep the recycle folder itself.
 */
function copyFor(strategy: TrashStrategy | undefined): TrashCopy {
  return strategy === "none" ? NONE_COPY : MOVE_COPY;
}

/** The storage row a Trash form edits. */
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
 * The Trash controls of the files folder: the settings live on its storage
 * row, so the form edits that row, on System > General and in the
 * walkthrough. Field ids carry the row's id so they stay unique on a page.
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
  const copy = copyFor(values?.strategy);
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
              <Field>
                <FieldLabel htmlFor={field("trash-path")}>Trash folder</FieldLabel>
                <Input
                  id={field("trash-path")}
                  value={values.path}
                  disabled={busy}
                  onChange={(event) => change({ path: event.target.value })}
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
                  This value is informational; fdrive does not delete old items automatically.
                </FieldDescription>
              </Field>
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

export interface TrashSettingsCardProps extends TrashSettingsFormProps {
  /** One line under the title, such as where to change this later. */
  description?: string;
}

/** The Trash form inside a titled card, on System > General and in the walkthrough. */
export function TrashSettingsCard({ description, ...props }: TrashSettingsCardProps) {
  return (
    <SystemSection
      title="Trash"
      {...(description === undefined ? {} : { description })}
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
