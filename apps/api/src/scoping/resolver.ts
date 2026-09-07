import type { StorageProvider } from "@fdrive/core";
import { parseHomeTemplate, type Scope, scopesFor } from "@fdrive/core";
import type { Identity, ProviderRepo } from "@fdrive/db";
import type { IndexRootConfig } from "../config.ts";
import type { ConnectionStore } from "../connection/store.ts";
import type { IndexerClient } from "../system/indexer-client.ts";
import {
  createScopeCache,
  DEFAULT_SCOPE_CACHE_MAX_ENTRIES,
  DEFAULT_SCOPE_CACHE_TTL_MS,
} from "./cache.ts";
import { shadowedChildNames, verifyMountDirectory } from "./directory-verify.ts";
import type { ScopeOverrideStore } from "./override-store.ts";
import type {
  ConfiguredMappingsResult,
  DirectoryEntryLite,
  ScopeStatus,
  VerifiedIndexScopesResult,
  VerifiedUnavailableReason,
} from "./types.ts";
import { validateScopeOverrides } from "./validate-overrides.ts";

/**
 * Standing advisory text returned with every `ScopeResolver.status` result.
 * Administrator-controlled scope mappings are an authorization boundary,
 * not proof that two matching root or path names are the same storage; a
 * deliberately wrong mapping is not repaired by the checks in this module.
 * See `docs/workflow/P5-SCOPES.md`.
 */
export const SCOPE_STATUS_WARNING =
  "Administrator-controlled scope mappings are an authorization boundary. Matching root or path names never prove two storage locations are identical, and this check cannot repair a deliberately wrong mapping.";

/** Default bound on concurrent SFTP/indexer probes during `verifiedIndexScopes`. */
export const DEFAULT_VERIFY_CONCURRENCY = 6;

export interface ScopeResolver {
  /**
   * The identity's trusted, administrator-controlled scope mapping: the
   * home scope derived from the currently configured connection's home
   * template plus any stored per-identity override. Available even when
   * the indexer is down or has never seen these roots.
   */
  configuredMappings(identity: Identity): Promise<ConfiguredMappingsResult>;
  /**
   * The subset of `configuredMappings` whose root is indexed, restricted
   * further to only the scopes that pass live SFTP-vs-indexer directory
   * verification. Index-backed features (search, duplicates, thumbnails,
   * extraction, MCP) must use this, never `configuredMappings`.
   */
  verifiedIndexScopes(identity: Identity): Promise<VerifiedIndexScopesResult>;
  /** The status shown on the account page: mirrors `IdentityScopeResponse`, redacted for a non-administrator. */
  status(identity: Identity, isAdmin: boolean): Promise<ScopeStatus>;
  /** Validates and replaces the identity's stored override. An empty list resets to the plain template. */
  setOverrides(identity: Identity, scopes: readonly Scope[]): Promise<void>;
}

export interface CreateScopeResolverDeps {
  readonly providers: Pick<ProviderRepo, "get">;
  readonly overrides: ScopeOverrideStore;
  readonly connection: Pick<ConnectionStore, "current">;
  /** The shape of `AppConfig.fdriveIndexRoots`: `null` when search/index features are disabled entirely. */
  readonly indexRoots: readonly IndexRootConfig[] | null;
  readonly indexer: Pick<IndexerClient, "directory">;
  readonly storageForIdentity: (identity: Identity) => Promise<StorageProvider>;
  readonly clock: () => Date;
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly verifyConcurrency?: number;
}

function buildVerificationCacheKey(input: {
  readonly identityId: string;
  readonly providerId: string;
  readonly homeTemplateRaw: string;
  readonly indexRoots: readonly IndexRootConfig[];
  readonly overrides: readonly Scope[];
}): string {
  const payload = {
    providerId: input.providerId,
    homeTemplateRaw: input.homeTemplateRaw,
    indexRoots: input.indexRoots.map((root) => root.name).toSorted(),
    overrides: input.overrides.map((scope) => [
      scope.rootName,
      scope.fsPrefix,
      scope.virtualPrefix,
    ]),
  };
  return `${input.identityId}:${JSON.stringify(payload)}`;
}

/** A minimal counting semaphore bounding how many callers hold it at once. */
function createSemaphore(limit: number): { acquire: () => Promise<void>; release: () => void } {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      active += 1;
    },
    release() {
      active -= 1;
      const next = queue.shift();
      if (next !== undefined) next();
    },
  };
}

/** Builds the `ScopeResolver`, the single source of truth for what identities may read. */
export function createScopeResolver(deps: CreateScopeResolverDeps): ScopeResolver {
  const cache = createScopeCache<VerifiedIndexScopesResult>({
    ttlMs: deps.cacheTtlMs ?? DEFAULT_SCOPE_CACHE_TTL_MS,
    maxEntries: deps.maxCacheEntries ?? DEFAULT_SCOPE_CACHE_MAX_ENTRIES,
    clock: deps.clock,
  });

  async function configuredMappings(identity: Identity): Promise<ConfiguredMappingsResult> {
    const connection = await deps.connection.current();
    if (connection === null) {
      return { available: false, reason: "no_connection" };
    }

    const provider = await deps.providers.get(identity.providerId);
    if (
      provider === null ||
      provider.type !== "sftpgo" ||
      provider.baseUrl !== connection.baseUrl
    ) {
      return { available: false, reason: "provider_mismatch" };
    }

    const overrideRecord = await deps.overrides.get(identity.id);

    try {
      const template = parseHomeTemplate(connection.homeTemplate);
      const scopes = scopesFor({
        template,
        username: identity.externalUsername,
        overrides: overrideRecord?.scopes ?? [],
      });
      return {
        available: true,
        providerId: provider.id,
        homeTemplateRaw: connection.homeTemplate,
        scopes,
      };
    } catch {
      return { available: false, reason: "invalid_configuration" };
    }
  }

  async function verifyCandidates(
    identity: Identity,
    candidates: readonly Scope[],
    allScopes: readonly Scope[],
  ): Promise<VerifiedIndexScopesResult> {
    let storage: StorageProvider;
    try {
      storage = await deps.storageForIdentity(identity);
    } catch {
      return { available: false, reason: "mismatch" };
    }

    const semaphore = createSemaphore(deps.verifyConcurrency ?? DEFAULT_VERIFY_CONCURRENCY);
    let failure: VerifiedUnavailableReason | null = null;

    async function verifyOne(scope: Scope): Promise<void> {
      await semaphore.acquire();
      try {
        if (failure !== null) return;
        const excluded = shadowedChildNames(scope, allScopes);

        let sftpEntries: DirectoryEntryLite[];
        try {
          // The identity's storage speaks virtual paths; the indexer speaks physical ones.
          const listed = await storage.list(scope.virtualPrefix);
          sftpEntries = listed.map((entry) => ({ name: entry.name, kind: entry.kind }));
        } catch {
          failure ??= "mismatch";
          return;
        }

        const indexResult = await deps.indexer.directory(scope.rootName, scope.fsPrefix);
        if (!indexResult.ok) {
          failure ??= "indexer_unreachable";
          return;
        }

        const verified = verifyMountDirectory({
          sftpEntries,
          indexEntries: indexResult.data.items,
          indexOverflow: indexResult.data.overflow,
          excludedNames: excluded,
        });
        if (!verified.ok) {
          failure ??= verified.reason;
        }
      } finally {
        semaphore.release();
      }
    }

    await Promise.all(candidates.map((scope) => verifyOne(scope)));

    return failure === null
      ? { available: true, scopes: candidates }
      : { available: false, reason: failure };
  }

  async function verifiedIndexScopes(identity: Identity): Promise<VerifiedIndexScopesResult> {
    const configured = await configuredMappings(identity);
    if (!configured.available) {
      return { available: false, reason: configured.reason };
    }

    const indexRoots = deps.indexRoots ?? [];
    const indexRootNames = new Set(indexRoots.map((root) => root.name));
    const candidates = configured.scopes.filter((scope) => indexRootNames.has(scope.rootName));
    if (candidates.length === 0) {
      return { available: false, reason: "no_roots" };
    }

    const overrideRecord = await deps.overrides.get(identity.id);
    const cacheKey = buildVerificationCacheKey({
      identityId: identity.id,
      providerId: configured.providerId,
      homeTemplateRaw: configured.homeTemplateRaw,
      indexRoots,
      overrides: overrideRecord?.scopes ?? [],
    });

    return cache.get(cacheKey, () => verifyCandidates(identity, candidates, configured.scopes));
  }

  async function status(identity: Identity, isAdmin: boolean): Promise<ScopeStatus> {
    const overrideRecord = await deps.overrides.get(identity.id);
    const usesOverride = (overrideRecord?.scopes.length ?? 0) > 0;
    const configured = await configuredMappings(identity);

    if (!configured.available) {
      const configuredRootNames = (deps.indexRoots ?? []).map((root) => root.name);
      return isAdmin
        ? {
            status: "unavailable",
            reason: configured.reason,
            usesOverride,
            virtualPrefixes: [],
            warning: SCOPE_STATUS_WARNING,
            isAdmin: true,
            configuredRoots: configuredRootNames,
            mappings: [],
          }
        : {
            status: "unavailable",
            reason: configured.reason,
            usesOverride,
            virtualPrefixes: [],
            warning: SCOPE_STATUS_WARNING,
            isAdmin: false,
          };
    }

    const verified = await verifiedIndexScopes(identity);
    const virtualPrefixes = configured.scopes.map((scope) => scope.virtualPrefix);
    const configuredRootNames = Array.from(
      new Set([
        ...(deps.indexRoots ?? []).map((root) => root.name),
        ...configured.scopes.map((scope) => scope.rootName),
      ]),
    );

    if (verified.available) {
      return isAdmin
        ? {
            status: "available",
            reason: "ok",
            usesOverride,
            virtualPrefixes,
            warning: SCOPE_STATUS_WARNING,
            isAdmin: true,
            configuredRoots: configuredRootNames,
            mappings: configured.scopes,
          }
        : {
            status: "available",
            reason: "ok",
            usesOverride,
            virtualPrefixes,
            warning: SCOPE_STATUS_WARNING,
            isAdmin: false,
          };
    }

    return isAdmin
      ? {
          status: "unavailable",
          reason: verified.reason,
          usesOverride,
          virtualPrefixes,
          warning: SCOPE_STATUS_WARNING,
          isAdmin: true,
          configuredRoots: configuredRootNames,
          mappings: configured.scopes,
        }
      : {
          status: "unavailable",
          reason: verified.reason,
          usesOverride,
          virtualPrefixes,
          warning: SCOPE_STATUS_WARNING,
          isAdmin: false,
        };
  }

  async function setOverrides(identity: Identity, scopes: readonly Scope[]): Promise<void> {
    validateScopeOverrides(scopes);
    if (scopes.length === 0) {
      await deps.overrides.reset(identity.id);
    } else {
      await deps.overrides.set(identity.id, scopes);
    }
    cache.invalidatePrefix(`${identity.id}:`);
  }

  return { configuredMappings, verifiedIndexScopes, status, setOverrides };
}
