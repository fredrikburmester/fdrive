import type { IdentityScopeReason, UnmappedMount } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";

export type { Scope } from "@fdrive/core";

/**
 * Reasons `configuredMappings` can be unavailable. These describe a broken
 * or ambiguous *configuration* (no active connection, the identity's
 * provider is not the currently configured one, or the stored home
 * template/overrides cannot be applied), never a transient index problem.
 */
export type ConfiguredUnavailableReason = Extract<
  IdentityScopeReason,
  "no_connection" | "provider_mismatch" | "invalid_configuration"
>;

/**
 * Reasons `verifiedIndexScopes` can be unavailable: every
 * `ConfiguredUnavailableReason` (a broken configured mapping makes the
 * index unusable too), plus reasons specific to index verification.
 */
export type VerifiedUnavailableReason =
  | ConfiguredUnavailableReason
  | Extract<
      IdentityScopeReason,
      "no_roots" | "mismatch" | "overflow" | "indexer_unreachable" | "unmapped_mount"
    >;

/**
 * Why one candidate scope failed live SFTP-vs-index verification. Ordered
 * from most to least severe in `SCOPE_FAILURE_SEVERITY`: an unreachable
 * indexer or an overflowed listing says nothing about the mapping, a
 * `mismatch` is a genuine inconsistency, and an `unmapped_mount` is the
 * one case an administrator can fix from the account page.
 */
export type ScopeVerificationFailureReason = Extract<
  VerifiedUnavailableReason,
  "indexer_unreachable" | "overflow" | "mismatch" | "unmapped_mount"
>;

/** `ScopeVerificationFailureReason` values from most to least severe. */
export const SCOPE_FAILURE_SEVERITY: readonly ScopeVerificationFailureReason[] = [
  "indexer_unreachable",
  "overflow",
  "mismatch",
  "unmapped_mount",
];

/** One candidate scope that did not verify, and (for `unmapped_mount`) the entries that caused it. */
export interface ScopeVerificationFailure {
  readonly virtualPrefix: string;
  readonly reason: ScopeVerificationFailureReason;
  /** SFTP-visible entries absent from the index at this scope's mount directory, as virtual paths. */
  readonly unmappedMounts: readonly UnmappedMount[];
}

/**
 * The full per-scope outcome of verification, cached by the resolver:
 * every candidate that verified plus every one that did not. `available`
 * when at least one scope survived. `ScopeResolver.status` reports this in
 * detail; `verifiedIndexScopes` projects it to `VerifiedIndexScopesResult`.
 */
export type ScopeVerificationPass =
  | {
      readonly available: true;
      readonly scopes: readonly Scope[];
      readonly failures: readonly ScopeVerificationFailure[];
    }
  | {
      readonly available: false;
      readonly reason: VerifiedUnavailableReason;
      readonly failures: readonly ScopeVerificationFailure[];
    };

export type ScopeVerificationOutcome = ScopeVerificationPass & {
  /** Folder-level mappings adopted for this identity, as scopes; already part of `scopes` when verified. */
  readonly adopted: readonly Scope[];
};

/**
 * The result of resolving an identity's *configured* (trusted,
 * administrator-controlled) scope mapping: the home scope derived from the
 * current connection's template plus any stored per-identity overrides.
 * Available even when the indexer is down; `verifiedIndexScopes` is the
 * separate, stricter check index-backed features must use instead.
 */
export type ConfiguredMappingsResult =
  | {
      readonly available: true;
      readonly providerId: string;
      /** The raw, unparsed home template string in effect, for cache-key purposes. */
      readonly homeTemplateRaw: string;
      readonly scopes: readonly Scope[];
    }
  | { readonly available: false; readonly reason: ConfiguredUnavailableReason };

/**
 * The result of verifying an identity's configured scopes against the
 * indexer's own view of disk, restricted to the subset of scopes whose
 * root is actually indexed. Only index-backed features (search,
 * duplicates, thumbnails, extraction, MCP) may use this; never fall back
 * to `configuredMappings` for those.
 */
export type VerifiedIndexScopesResult =
  | { readonly available: true; readonly scopes: readonly Scope[] }
  | { readonly available: false; readonly reason: VerifiedUnavailableReason };

interface ScopeStatusCommon {
  readonly status: "available" | "unavailable";
  readonly reason: IdentityScopeReason;
  /** Whether the identity currently has a stored override rather than only the template-derived home scope. */
  readonly usesOverride: boolean;
  readonly virtualPrefixes: readonly string[];
  /** SFTP-visible entries the index lacks that look like unmapped mounts, as virtual paths. */
  readonly unmappedMounts: readonly UnmappedMount[];
  /** Virtual prefixes dropped from the verified set while at least one other scope survived. */
  readonly unverifiedPrefixes: readonly string[];
  /** The stored acknowledgements, returned so the account page can preserve them across saves. */
  readonly unindexedPrefixes: readonly string[];
  readonly warning: string;
}

/**
 * The result of `ScopeResolver.status`, mirroring `@fdrive/contracts`'
 * `IdentityScopeResponse` field for field: a non-administrator gets only
 * `virtualPrefixes` and status, an administrator additionally gets every
 * configured root name and the full root/filesystem-prefix mapping.
 */
export type ScopeStatus =
  | (ScopeStatusCommon & { readonly isAdmin: false })
  | (ScopeStatusCommon & {
      readonly isAdmin: true;
      readonly configuredRoots: readonly string[];
      readonly mappings: readonly Scope[];
      readonly overrides: readonly Scope[];
      /** Folder-level mappings currently adopted for this identity. */
      readonly adoptedMappings: readonly Scope[];
    });

/** One filesystem entry as seen by either the live SFTP listing or the indexer's own directory listing. */
export interface DirectoryEntryLite {
  readonly name: string;
  readonly kind: "file" | "dir" | "symlink" | "other";
}
