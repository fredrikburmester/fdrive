"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export interface SettingsFormActionsProps {
  dirty: boolean;
  invalid: boolean;
  pending: boolean;
  onSave: () => void;
  onReset: () => void;
}

/**
 * Save and Reset for a settings draft: Save is disabled until the draft is
 * both dirty and valid, Reset until it is dirty. Rendered inline by
 * `SettingsFormShell` and in the footer by `SettingsSheet`, so both places
 * agree on when each button is available.
 */
export function SettingsFormActions({
  dirty,
  invalid,
  pending,
  onSave,
  onReset,
}: SettingsFormActionsProps) {
  return (
    <>
      <Button type="button" variant="outline" disabled={!dirty || pending} onClick={onReset}>
        Reset
      </Button>
      <Button type="button" disabled={!dirty || invalid || pending} onClick={onSave}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </>
  );
}

export interface SettingsFormShellProps extends SettingsFormActionsProps {
  children: ReactNode;
}

/** A settings form with its Save/Reset row below the fields. */
export function SettingsFormShell({ children, ...actions }: SettingsFormShellProps) {
  return (
    <div className="flex flex-col gap-4">
      {children}
      <div className="flex justify-end gap-2">
        <SettingsFormActions {...actions} />
      </div>
    </div>
  );
}

export interface GlobsFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
}

/** A `Textarea`-backed field for a glob list, one pattern per line. */
export function GlobsField({ id, label, value, onChange, description }: GlobsFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        placeholder="One pattern per line"
        className="font-mono text-sm"
      />
      {description !== undefined ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
