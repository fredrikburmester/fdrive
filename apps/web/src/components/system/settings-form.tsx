"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export interface SettingsFormShellProps {
  dirty: boolean;
  invalid: boolean;
  pending: boolean;
  onSave: () => void;
  onReset: () => void;
  children: ReactNode;
}

/**
 * The Save/Reset row shared by every settings form on the System pages: Save
 * is disabled until the draft is both dirty and valid, Reset is disabled
 * until the draft is dirty.
 */
export function SettingsFormShell({
  dirty,
  invalid,
  pending,
  onSave,
  onReset,
  children,
}: SettingsFormShellProps) {
  return (
    <div className="flex flex-col gap-4">
      {children}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={!dirty || pending} onClick={onReset}>
          Reset
        </Button>
        <Button type="button" disabled={!dirty || invalid || pending} onClick={onSave}>
          {pending ? "Saving…" : "Save"}
        </Button>
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
