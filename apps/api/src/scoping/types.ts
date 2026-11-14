import type { IdentityScopeReason } from "@fdrive/contracts";
import type { Scope } from "@fdrive/core";

export type { Scope } from "@fdrive/core";

/**
 * Why an identity's scopes are unavailable: its provider is missing or
 * disabled, its username cannot name a folder, or its storage is not under
 * any index root. `no_connection` is for callers that have no identity at
 * all; the resolver never returns it.
 */
export type UnavailableReason = Exclude<IdentityScopeReason, "ok">;

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
  | { readonly available: false; readonly reason: UnavailableReason };

/**
 * The configured scopes whose root is one of the indexed roots
 * (`FDRIVE_INDEX_ROOTS`). Only index-backed features (search, duplicates,
 * thumbnails, folder sizes, extraction, MCP) may use this, and every result
 * still passes a live read check.
 */
export type VerifiedIndexScopesResult =
  | { readonly available: true; readonly scopes: readonly Scope[] }
  | { readonly available: false; readonly reason: UnavailableReason };
