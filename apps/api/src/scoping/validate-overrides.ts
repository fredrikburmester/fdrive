import { MAX_SCOPE_MAPPINGS, ScopeMapping } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";

export type ScopeOverrideValidationReason =
  | "too_many"
  | "invalid_mapping"
  | "duplicate_virtual_prefix";

/** Thrown by `validateScopeOverrides` (and `ScopeResolver.setOverrides`) on the first violation found. */
export class ScopeOverrideValidationError extends Error {
  readonly reason: ScopeOverrideValidationReason;

  constructor(reason: ScopeOverrideValidationReason, message: string) {
    super(message);
    this.name = "ScopeOverrideValidationError";
    this.reason = reason;
    Object.setPrototypeOf(this, ScopeOverrideValidationError.prototype);
  }
}

/**
 * Validates a candidate list of scope overrides: at most
 * `MAX_SCOPE_MAPPINGS` entries, each a well-formed `{ rootName, fsPrefix,
 * virtualPrefix }` (reusing the exact `@fdrive/contracts` `ScopeMapping`
 * schema so client and server can never disagree on what a valid mapping
 * looks like), and no duplicate `virtualPrefix` across the list. Throws
 * `ScopeOverrideValidationError` on the first violation; never mutates
 * `scopes` and has no side effects.
 */
export function validateScopeOverrides(scopes: readonly Scope[]): void {
  if (scopes.length > MAX_SCOPE_MAPPINGS) {
    throw new ScopeOverrideValidationError(
      "too_many",
      `at most ${MAX_SCOPE_MAPPINGS} scope mappings are allowed`,
    );
  }

  const seenVirtualPrefixes = new Set<string>();
  for (const scope of scopes) {
    const parsed = ScopeMapping.safeParse(scope);
    if (!parsed.success) {
      throw new ScopeOverrideValidationError(
        "invalid_mapping",
        `invalid scope mapping: ${parsed.error.message}`,
      );
    }
    if (seenVirtualPrefixes.has(parsed.data.virtualPrefix)) {
      throw new ScopeOverrideValidationError(
        "duplicate_virtual_prefix",
        `duplicate virtualPrefix: ${parsed.data.virtualPrefix}`,
      );
    }
    seenVirtualPrefixes.add(parsed.data.virtualPrefix);
  }
}
