import { MAX_SCOPE_MAPPINGS, ScopeCanonicalPath, ScopeMapping } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";

export type ScopeOverrideValidationReason =
  | "too_many"
  | "invalid_mapping"
  | "unknown_root"
  | "duplicate_virtual_prefix"
  | "invalid_unindexed_prefix"
  | "duplicate_unindexed_prefix"
  | "unindexed_prefix_collision";

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

export interface ValidateScopeOverridesOptions {
  /**
   * Root names a mapping may refer to. When given, a mapping naming any
   * other root is rejected as `unknown_root`; when omitted, root names are
   * only checked for shape.
   */
  readonly knownRoots?: ReadonlySet<string>;
}

/**
 * Validates a candidate override: at most `MAX_SCOPE_MAPPINGS` mappings,
 * each a well-formed `{ rootName, fsPrefix, virtualPrefix }` (reusing the
 * exact `@fdrive/contracts` `ScopeMapping` schema so client and server can
 * never disagree on what a valid mapping looks like) on a known root, with
 * no duplicate `virtualPrefix`; and at most `MAX_SCOPE_MAPPINGS` canonical,
 * unique `unindexedPrefixes`, none of which is also a mapped
 * `virtualPrefix`. Throws `ScopeOverrideValidationError` on the first
 * violation; never mutates its inputs and has no side effects.
 */
export function validateScopeOverrides(
  scopes: readonly Scope[],
  unindexedPrefixes: readonly string[] = [],
  options: ValidateScopeOverridesOptions = {},
): void {
  if (scopes.length > MAX_SCOPE_MAPPINGS) {
    throw new ScopeOverrideValidationError(
      "too_many",
      `at most ${MAX_SCOPE_MAPPINGS} scope mappings are allowed`,
    );
  }
  if (unindexedPrefixes.length > MAX_SCOPE_MAPPINGS) {
    throw new ScopeOverrideValidationError(
      "too_many",
      `at most ${MAX_SCOPE_MAPPINGS} unindexed prefixes are allowed`,
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
    if (options.knownRoots !== undefined && !options.knownRoots.has(parsed.data.rootName)) {
      throw new ScopeOverrideValidationError(
        "unknown_root",
        `unknown root: ${parsed.data.rootName}`,
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

  const seenUnindexed = new Set<string>();
  for (const prefix of unindexedPrefixes) {
    if (!ScopeCanonicalPath.safeParse(prefix).success) {
      throw new ScopeOverrideValidationError(
        "invalid_unindexed_prefix",
        `invalid unindexed prefix: ${prefix}`,
      );
    }
    if (seenUnindexed.has(prefix)) {
      throw new ScopeOverrideValidationError(
        "duplicate_unindexed_prefix",
        `duplicate unindexed prefix: ${prefix}`,
      );
    }
    if (seenVirtualPrefixes.has(prefix)) {
      throw new ScopeOverrideValidationError(
        "unindexed_prefix_collision",
        `unindexed prefix collides with a mapped virtualPrefix: ${prefix}`,
      );
    }
    seenUnindexed.add(prefix);
  }
}
