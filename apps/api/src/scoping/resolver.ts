import { isSafeSegment, type Scope } from "@fdrive/core";
import type { Identity } from "@fdrive/db";
import type { ProviderService } from "../providers/service.ts";
import type { ConfiguredMappingsResult, VerifiedIndexScopesResult } from "./types.ts";

/**
 * Where each identity's files sit under the index roots. A login's home is
 * always `<root>/<username>` on the index root its provider names
 * (`ProviderModule.indexRootName`), shown at "/" in its virtual filesystem;
 * nothing is configured per identity. See `docs/SCOPING.md`.
 */
export interface ScopeResolver {
  /**
   * The identity's trusted scopes, whether or not their root is indexed:
   * Office and index events use these. Reads the provider row only, never
   * storage or the indexer.
   */
  configuredMappings(identity: Identity): Promise<ConfiguredMappingsResult>;
  /**
   * The configured scopes whose root is indexed. Index-backed features
   * (search, duplicates, thumbnails, folder sizes, extraction, MCP) must use
   * this, and must still check each result with a live read.
   */
  verifiedIndexScopes(identity: Identity): Promise<VerifiedIndexScopesResult>;
}

/**
 * More scopes for one identity, appended after its home: for example
 * another user's folder shown at `/Shared with me/<name>`, as
 * `{ rootName: home.rootName, fsPrefix: "/<owner>/<path>", virtualPrefix:
 * "/Shared with me/<name>" }`. Each scope must be canonical, and its
 * `virtualPrefix` must not be "/". A scope nested inside the home shadows
 * the home's own folder at that path: the scope helpers pick the longest
 * prefix, and `roundTripVirtualPath` drops index rows from the shadowed
 * folder.
 */
export type ExtraScopes = (identity: Identity, home: Scope) => Promise<readonly Scope[]>;

export interface CreateScopeResolverDeps {
  readonly providers: Pick<ProviderService, "get">;
  /** The names in `FDRIVE_INDEX_ROOTS`; empty when nothing is indexed. */
  readonly indexRootNames: Iterable<string>;
  /** Defaults to none. */
  readonly extraScopes?: ExtraScopes;
}

/** Builds the `ScopeResolver`, the single source of truth for what identities may read from the index. */
export function createScopeResolver(deps: CreateScopeResolverDeps): ScopeResolver {
  const indexed = new Set(deps.indexRootNames);

  async function configuredMappings(identity: Identity): Promise<ConfiguredMappingsResult> {
    const resolved = await deps.providers.get(identity.providerId);
    if (resolved === null || !resolved.provider.enabled) {
      return { available: false, reason: "provider_mismatch" };
    }
    const rootName = resolved.module.indexRootName?.(resolved.instance) ?? null;
    if (rootName === null) return { available: false, reason: "no_roots" };
    // The username names the home folder, so it must be exactly one segment.
    if (!isSafeSegment(identity.externalUsername)) {
      return { available: false, reason: "invalid_configuration" };
    }
    const home: Scope = { rootName, fsPrefix: `/${identity.externalUsername}`, virtualPrefix: "/" };
    const extra = deps.extraScopes === undefined ? [] : await deps.extraScopes(identity, home);
    return { available: true, providerId: resolved.provider.id, scopes: [home, ...extra] };
  }

  async function verifiedIndexScopes(identity: Identity): Promise<VerifiedIndexScopesResult> {
    const configured = await configuredMappings(identity);
    if (!configured.available) return configured;
    const scopes = configured.scopes.filter((scope) => indexed.has(scope.rootName));
    return scopes.length > 0
      ? { available: true, scopes }
      : { available: false, reason: "no_roots" };
  }

  return { configuredMappings, verifiedIndexScopes };
}
