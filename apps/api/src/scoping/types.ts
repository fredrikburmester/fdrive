import type { IdentityScopeReason } from "@fdrive/contracts";
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
  | Extract<IdentityScopeReason, "no_roots" | "mismatch" | "overflow" | "indexer_unreachable">;

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
    });

/** One filesystem entry as seen by either the live SFTP listing or the indexer's own directory listing. */
export interface DirectoryEntryLite {
  readonly name: string;
  readonly kind: "file" | "dir" | "symlink" | "other";
}
