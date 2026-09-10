import type { ProviderField } from "./ports/provider.ts";

const DEFAULT_MAX_LENGTH = 4096;

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export type FieldValidation =
  | { readonly ok: true; readonly value: Record<string, string> }
  | { readonly ok: false; readonly issues: readonly FieldIssue[] };

/**
 * Validates `input` against `fields`: every required field is a non-empty
 * string, no value exceeds its `maxLength`, no value contains NUL, and
 * unknown keys are rejected. Returns only the declared fields, so a
 * caller can seal or store the result as is.
 */
export function validateFields(fields: readonly ProviderField[], input: unknown): FieldValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "", message: "expected an object" }] };
  }
  const record = input as Record<string, unknown>;
  const known = new Set(fields.map((f) => f.name));
  const issues: FieldIssue[] = Object.keys(record)
    .filter((k) => !known.has(k))
    .map((field) => ({ field, message: "unknown field" }));

  const value: Record<string, string> = {};
  for (const { name, required, maxLength = DEFAULT_MAX_LENGTH } of fields) {
    const raw = record[name];
    if (raw === undefined || raw === "") {
      if (required) issues.push({ field: name, message: "required" });
    } else if (typeof raw !== "string") {
      issues.push({ field: name, message: "expected a string" });
    } else if (raw.includes("\0")) {
      issues.push({ field: name, message: "must not contain NUL" });
    } else if (raw.length > maxLength) {
      issues.push({ field: name, message: "too long" });
    } else {
      value[name] = raw;
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/** Drops every `transient` field (a one-time code) before a credential is stored. */
export function stripTransientFields(
  fields: readonly ProviderField[],
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  const transient = new Set(fields.filter((f) => f.transient).map((f) => f.name));
  return Object.fromEntries(Object.entries(value).filter(([k]) => !transient.has(k)));
}

/** True when the two credentials store the same non-transient values. */
export function sameCredential(
  fields: readonly ProviderField[],
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  return fields.every((f) => f.transient || a[f.name] === b[f.name]);
}
