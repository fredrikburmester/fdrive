import type { IdentityScopeReason } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";

export type { Scope } from "@fdrive/core";

/**
 * Why an identity has no configured scopes: its provider is missing or
 * disabled, its username cannot name a folder, or its storage is not under
 * any index root. `no_connection` is for callers that have no identity at
 * all; the resolver never returns it.
 */
export type ConfiguredUnavailableReason = Extract<
  IdentityScopeReason,
  "no_connection" | "provider_mismatch" | "invalid_configuration" | "no_roots"
>;

/**
 * Why index-backed features are unavailable for an identity. Every
 * contract reason except "ok", so callers and fakes may report the ones
 * the web still recognizes; the resolver itself only returns a
 * `ConfiguredUnavailableReason`.
 */
export type VerifiedUnavailableReason = Exclude<IdentityScopeReason, "ok">;

/**
 * An identity's trusted scopes: where its virtual paths live under an
 * index root, whether or not that root is indexed. Office and index events
 * use these; index-backed reads use `VerifiedIndexScopesResult`.
 */
export type ConfiguredMappingsResult =
  | {
      readonly available: true;
      readonly providerId: string;
      readonly scopes: readonly Scope[];
    }
  | { readonly available: false; readonly reason: ConfiguredUnavailableReason };

/**
 * The configured scopes whose root is one of the indexed roots
 * (`FDRIVE_INDEX_ROOTS`). Only index-backed features (search, duplicates,
 * thumbnails, folder sizes, extraction, MCP) may use this, and every result
 * still passes a live read check.
 */
export type VerifiedIndexScopesResult =
  | { readonly available: true; readonly scopes: readonly Scope[] }
  | { readonly available: false; readonly reason: VerifiedUnavailableReason };
