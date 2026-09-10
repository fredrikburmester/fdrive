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
  const known = new Set(fields.map((field) => field.name));
  const issues: FieldIssue[] = [];
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      issues.push({ field: key, message: "unknown field" });
    }
  }
  const value: Record<string, string> = {};
  for (const field of fields) {
    const raw = record[field.name];
    if (raw === undefined || raw === "") {
      if (field.required) {
        issues.push({ field: field.name, message: "required" });
      }
      continue;
    }
    if (typeof raw !== "string") {
      issues.push({ field: field.name, message: "expected a string" });
      continue;
    }
    if (raw.includes("\0")) {
      issues.push({ field: field.name, message: "must not contain NUL" });
      continue;
    }
    if (raw.length > (field.maxLength ?? DEFAULT_MAX_LENGTH)) {
      issues.push({ field: field.name, message: "too long" });
      continue;
    }
    value[field.name] = raw;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/** Drops every `transient` field (a one-time code) before a credential is stored. */
export function stripTransientFields(
  fields: readonly ProviderField[],
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  const transient = new Set(fields.filter((field) => field.transient === true).map((f) => f.name));
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!transient.has(key)) {
      result[key] = entry;
    }
  }
  return result;
}

/** True when the two credentials store the same non-transient values. */
export function sameCredential(
  fields: readonly ProviderField[],
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  for (const field of fields) {
    if (field.transient === true) {
      continue;
    }
    if (a[field.name] !== b[field.name]) {
      return false;
    }
  }
  return true;
}
