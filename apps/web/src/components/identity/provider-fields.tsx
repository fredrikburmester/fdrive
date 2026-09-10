"use client";

import type { ProviderField } from "@fdrive/contracts";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface ProviderFieldInputsProps {
  /** The fields to render, in order. */
  readonly fields: readonly ProviderField[];
  /** Current values by field name; a missing name renders empty. */
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (name: string, value: string) => void;
  /** Prefix for every input's DOM id, so two field lists on one page never collide. */
  readonly idPrefix: string;
  readonly disabled?: boolean;
  /** Focuses the first field on mount. */
  readonly autoFocus?: boolean;
  /**
   * Keeps an optional one-time code field behind a "Use a one-time code"
   * link until the person asks for it, as the login page always did; the
   * account dialogs show it straight away.
   */
  readonly revealOptionalCode?: boolean;
  /** Names of optional code fields the person has revealed (only with `revealOptionalCode`). */
  readonly revealed?: ReadonlySet<string>;
  readonly onReveal?: (name: string) => void;
}

function autoCompleteFor(field: ProviderField): string | undefined {
  switch (field.kind) {
    case "password":
      return "current-password";
    case "otp":
      return "one-time-code";
    case "text":
      return field.name === "username" ? "username" : undefined;
    case "url":
      return "url";
  }
}

function inputTypeFor(field: ProviderField): string {
  switch (field.kind) {
    case "password":
      return "password";
    case "url":
      return "url";
    default:
      return "text";
  }
}

/**
 * Renders a provider's credential (or configuration) fields exactly as the
 * API describes them: the same list drives the login page, the Add and
 * Remove login dialogs and System > Storage, so a new provider type needs
 * no form of its own.
 */
export function ProviderFieldInputs({
  fields,
  values,
  onChange,
  idPrefix,
  disabled = false,
  autoFocus = false,
  revealOptionalCode = false,
  revealed,
  onReveal,
}: ProviderFieldInputsProps) {
  return (
    <>
      {fields.map((field, index) => {
        const id = `${idPrefix}-${field.name}`;
        const hidden =
          revealOptionalCode &&
          field.kind === "otp" &&
          !field.required &&
          !(revealed?.has(field.name) ?? false);
        if (hidden) {
          return (
            <Button
              key={field.name}
              type="button"
              variant="link"
              className="h-auto w-fit justify-start p-0 text-muted-foreground"
              disabled={disabled}
              onClick={() => onReveal?.(field.name)}
            >
              Use a one-time code
            </Button>
          );
        }
        return (
          <Field key={field.name}>
            <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
            <Input
              id={id}
              name={field.name}
              type={inputTypeFor(field)}
              inputMode={field.kind === "otp" ? "numeric" : undefined}
              autoComplete={autoCompleteFor(field)}
              autoFocus={autoFocus && index === 0}
              required={field.required}
              maxLength={field.maxLength ?? 4096}
              value={values[field.name] ?? ""}
              disabled={disabled}
              onChange={(event) => onChange(field.name, event.target.value)}
            />
            {field.help !== undefined && <FieldDescription>{field.help}</FieldDescription>}
          </Field>
        );
      })}
    </>
  );
}
