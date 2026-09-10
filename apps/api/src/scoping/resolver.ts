import { MAX_UNMAPPED_MOUNTS, type MountMapping, type UnmappedMount } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import { joinPath, parseHomeTemplate, type Scope, scopesFor } from "@fdrive/core";
import type { Identity, ProviderRepo } from "@fdrive/db";
import { sftpgoHomeTemplate } from "@fdrive/sftpgo";
import type { IndexRootConfig } from "../config.ts";
import type { IndexerClient } from "../system/indexer-client.ts";
import {
  createScopeCache,
  DEFAULT_SCOPE_CACHE_MAX_ENTRIES,
  DEFAULT_SCOPE_CACHE_TTL_MS,
} from "./cache.ts";
import { shadowedChildNames, verifyMountDirectory } from "./directory-verify.ts";
import { type MountMappingStore, validateMountMappings } from "./mount-mapping-store.ts";
import type { ScopeOverrideStore } from "./override-store.ts";
import {
  type ConfiguredMappingsResult,
  type DirectoryEntryLite,
  SCOPE_FAILURE_SEVERITY,
  type ScopeStatus,
  type ScopeVerificationFailure,
  type ScopeVerificationFailureReason,
  type ScopeVerificationOutcome,
  type ScopeVerificationPass,
  type VerifiedIndexScopesResult,
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
   * template, any stored per-identity override, and every folder-level
   * mapping adopted for this identity (see `docs/workflow/P8-FOLDER-MAPPINGS.md`).
   * The template and override parts are available even when the indexer
   * is down; adoption needs verification evidence, so with the indexer
   * unreachable only those base scopes are returned.
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
  /**
   * Validates and replaces the identity's stored override: the scope
   * mappings plus the virtual prefixes acknowledged as present but not
   * indexed. Empty lists for both reset the identity to the plain template.
   */
  setOverrides(
    identity: Identity,
    scopes: readonly Scope[],
    unindexedPrefixes?: readonly string[],
  ): Promise<void>;
  /** The folder-level mappings, as stored. */
  mountMappings(): Promise<readonly MountMapping[]>;
  /** Validates and replaces the folder-level mappings, invalidating every identity's verification. */
  setMountMappings(mappings: readonly MountMapping[]): Promise<void>;
}

export interface CreateScopeResolverDeps {
  readonly providers: Pick<ProviderRepo, "get" | "list">;
  readonly overrides: ScopeOverrideStore;
  readonly mountMappings: MountMappingStore;
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
  readonly unindexedPrefixes: readonly string[];
  readonly mountMappings: readonly MountMapping[];
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
    unindexedPrefixes: input.unindexedPrefixes,
    mountMappings: input.mountMappings.map((mapping) => [
      mapping.virtualPath,
      mapping.rootName,
      mapping.fsPrefix,
    ]),
  };
  return `${input.identityId}:${JSON.stringify(payload)}`;
}

/** The more severe of two failure reasons, per `SCOPE_FAILURE_SEVERITY`. */
function moreSevere(
  a: ScopeVerificationFailureReason,
  b: ScopeVerificationFailureReason,
): ScopeVerificationFailureReason {
  return SCOPE_FAILURE_SEVERITY.indexOf(a) <= SCOPE_FAILURE_SEVERITY.indexOf(b) ? a : b;
}

/** A failure record with no offending entries; `unmapped_mount` always carries at least one. */
function plainFailure(
  scope: Scope,
  reason: Exclude<ScopeVerificationFailureReason, "unmapped_mount">,
): ScopeVerificationFailure {
  return { virtualPrefix: scope.virtualPrefix, reason, unmappedMounts: [] };
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
  const cache = createScopeCache<ScopeVerificationOutcome>({
    ttlMs: deps.cacheTtlMs ?? DEFAULT_SCOPE_CACHE_TTL_MS,
    maxEntries: deps.maxCacheEntries ?? DEFAULT_SCOPE_CACHE_MAX_ENTRIES,
    clock: deps.clock,
  });

  /** The template-derived home scope plus stored overrides: no SFTP or indexer access. */
  async function baseMappings(identity: Identity): Promise<ConfiguredMappingsResult> {
    const provider = await deps.providers.get(identity.providerId);
    if (provider === null || !provider.enabled) {
      return { available: false, reason: "provider_mismatch" };
    }
    // Only SFTPGo providers can map onto an index root today: their files
    // are on a disk the indexer reads. Every other provider is not indexed.
    if (provider.type !== "sftpgo") {
      return { available: false, reason: "no_roots" };
    }
    const homeTemplateRaw = sftpgoHomeTemplate(provider);

    const overrideRecord = await deps.overrides.get(identity.id);

    try {
      const template = parseHomeTemplate(homeTemplateRaw);
      const scopes = scopesFor({
        template,
        username: identity.externalUsername,
        overrides: overrideRecord?.scopes ?? [],
      });
      return {
        available: true,
        providerId: provider.id,
        homeTemplateRaw,
        scopes,
      };
    } catch {
      return { available: false, reason: "invalid_configuration" };
    }
  }

  /**
   * Verifies every candidate independently and keeps the survivors: one
   * failing override never takes down the home scope, and one unmapped
   * virtual-folder mount in the home never takes down a healthy override.
   * A mount directory whose only problem is SFTP-visible entries the index
   * has never seen (each a plausible unmapped mount) fails as
   * `unmapped_mount`, naming them; a present-but-different-kind entry is a
   * real `mismatch`. Unmapped mounts still fail closed: the same symptom
   * appears when a mapping points at the wrong directory.
   */
  async function verifyCandidates(
    identity: Identity,
    candidates: readonly Scope[],
    allScopes: readonly Scope[],
    unindexedPrefixes: readonly string[],
  ): Promise<ScopeVerificationPass> {
    let storage: StorageProvider;
    try {
      storage = await deps.storageForIdentity(identity);
    } catch {
      return {
        available: false,
        reason: "mismatch",
        failures: candidates.map((scope) => plainFailure(scope, "mismatch")),
      };
    }

    const semaphore = createSemaphore(deps.verifyConcurrency ?? DEFAULT_VERIFY_CONCURRENCY);

    async function verifyOne(scope: Scope): Promise<ScopeVerificationFailure | null> {
      await semaphore.acquire();
      try {
        const excluded = shadowedChildNames(scope, allScopes, unindexedPrefixes);

        let sftpEntries: DirectoryEntryLite[];
        try {
          // The identity's storage speaks virtual paths; the indexer speaks physical ones.
          const listed = await storage.list(scope.virtualPrefix);
          sftpEntries = listed.map((entry) => ({ name: entry.name, kind: entry.kind }));
        } catch {
          return plainFailure(scope, "mismatch");
        }

        const indexResult = await deps.indexer.directory(scope.rootName, scope.fsPrefix);
        if (!indexResult.ok) {
          // An HTTP response about this directory is not a service outage.
          // Missing or inaccessible mappings still fail closed.
          return plainFailure(
            scope,
            [400, 403, 404].includes(indexResult.status ?? 0) ? "mismatch" : "indexer_unreachable",
          );
        }

        const verified = verifyMountDirectory({
          sftpEntries,
          indexEntries: indexResult.data.items,
          indexOverflow: indexResult.data.overflow,
          excludedNames: excluded,
        });
        if (verified.ok) {
          return null;
        }
        if (verified.reason === "overflow") {
          return plainFailure(scope, "overflow");
        }

        const mounts: UnmappedMount[] = [];
        for (const entry of verified.entries) {
          if (entry.problem !== "missing" || (entry.kind !== "file" && entry.kind !== "dir")) {
            return plainFailure(scope, "mismatch");
          }
          mounts.push({ virtualPath: joinPath(scope.virtualPrefix, entry.name), kind: entry.kind });
        }
        return {
          virtualPrefix: scope.virtualPrefix,
          reason: "unmapped_mount",
          unmappedMounts: mounts,
        };
      } finally {
        semaphore.release();
      }
    }

    const results = await Promise.all(candidates.map((scope) => verifyOne(scope)));
    const verified: Scope[] = [];
    const failures: ScopeVerificationFailure[] = [];
    for (const [index, failure] of results.entries()) {
      const scope = candidates[index] as Scope;
      if (failure === null) verified.push(scope);
      else failures.push(failure);
    }

    if (verified.length > 0) {
      return { available: true, scopes: verified, failures };
    }
    // `candidates` is never empty here (the caller reports `no_roots`
    // first), so nothing verified means every candidate failed. The least
    // severe reason is the neutral starting point for the fold.
    return {
      available: false,
      reason: failures.reduce<ScopeVerificationFailureReason>(
        (worst, failure) => moreSevere(worst, failure.reason),
        "unmapped_mount",
      ),
      failures,
    };
  }

  /**
   * Folder-level mappings this identity adopts, given the unmapped mounts
   * verification found: exactly those whose `virtualPath` is such a mount
   * and is not already a base scope. Evidence-based on purpose: a real
   * directory of the same name in a home is on disk, so it is never an
   * unmapped mount and never adopts a mapping.
   */
  function adoptableMappings(
    failures: readonly ScopeVerificationFailure[],
    baseScopes: readonly Scope[],
    mountMappings: readonly MountMapping[],
  ): Scope[] {
    const mountPaths = new Set(
      failures.flatMap((failure) => failure.unmappedMounts.map((mount) => mount.virtualPath)),
    );
    const basePrefixes = new Set(baseScopes.map((scope) => scope.virtualPrefix));
    return mountMappings
      .filter(
        (mapping) => mountPaths.has(mapping.virtualPath) && !basePrefixes.has(mapping.virtualPath),
      )
      .map((mapping) => ({
        rootName: mapping.rootName,
        fsPrefix: mapping.fsPrefix,
        virtualPrefix: mapping.virtualPath,
      }));
  }

  /**
   * Verifies the base scopes; when that turns up unmapped mounts covered by
   * folder-level mappings, adopts them and verifies again with the adopted
   * scopes in place (the mount name is then shadowed from its parent, and
   * the adopted scope is checked on its own). Nothing is adopted without
   * that evidence.
   */
  async function verifyWithAdoption(
    identity: Identity,
    baseScopes: readonly Scope[],
    indexRootNames: ReadonlySet<string>,
    unindexedPrefixes: readonly string[],
    mountMappings: readonly MountMapping[],
  ): Promise<ScopeVerificationOutcome> {
    const baseCandidates = baseScopes.filter((scope) => indexRootNames.has(scope.rootName));
    const first = await verifyCandidates(identity, baseCandidates, baseScopes, unindexedPrefixes);
    const adopted = adoptableMappings(first.failures, baseScopes, mountMappings);
    if (adopted.length === 0) {
      return { ...first, adopted: [] };
    }
    const allScopes = [...baseScopes, ...adopted];
    const candidates = allScopes.filter((scope) => indexRootNames.has(scope.rootName));
    const second = await verifyCandidates(identity, candidates, allScopes, unindexedPrefixes);
    return { ...second, adopted };
  }

  /** The cached per-scope verification outcome, or the configured-mapping failure that prevents one. */
  async function verify(identity: Identity): Promise<ScopeVerificationOutcome> {
    const base = await baseMappings(identity);
    if (!base.available) {
      return { available: false, reason: base.reason, failures: [], adopted: [] };
    }

    const indexRoots = deps.indexRoots ?? [];
    const indexRootNames = new Set(indexRoots.map((root) => root.name));
    if (!base.scopes.some((scope) => indexRootNames.has(scope.rootName))) {
      return { available: false, reason: "no_roots", failures: [], adopted: [] };
    }

    const overrideRecord = await deps.overrides.get(identity.id);
    const unindexedPrefixes = overrideRecord?.unindexedPrefixes ?? [];
    const mountMappings = await deps.mountMappings.get();
    const cacheKey = buildVerificationCacheKey({
      identityId: identity.id,
      providerId: base.providerId,
      homeTemplateRaw: base.homeTemplateRaw,
      indexRoots,
      overrides: overrideRecord?.scopes ?? [],
      unindexedPrefixes,
      mountMappings,
    });

    return cache.get(cacheKey, () =>
      verifyWithAdoption(identity, base.scopes, indexRootNames, unindexedPrefixes, mountMappings),
    );
  }

  async function configuredMappings(identity: Identity): Promise<ConfiguredMappingsResult> {
    const base = await baseMappings(identity);
    if (!base.available) return base;
    const outcome = await verify(identity);
    return outcome.adopted.length === 0
      ? base
      : { ...base, scopes: [...base.scopes, ...outcome.adopted] };
  }

  async function verifiedIndexScopes(identity: Identity): Promise<VerifiedIndexScopesResult> {
    const outcome = await verify(identity);
    return outcome.available
      ? { available: true, scopes: outcome.scopes }
      : { available: false, reason: outcome.reason };
  }

  async function status(identity: Identity, isAdmin: boolean): Promise<ScopeStatus> {
    const overrideRecord = await deps.overrides.get(identity.id);
    const usesOverride =
      (overrideRecord?.scopes.length ?? 0) > 0 ||
      (overrideRecord?.unindexedPrefixes.length ?? 0) > 0;
    const configured = await configuredMappings(identity);
    const configuredScopes = configured.available ? configured.scopes : [];
    const configuredRoots = Array.from(
      new Set([
        ...(deps.indexRoots ?? []).map((root) => root.name),
        ...configuredScopes.map((scope) => scope.rootName),
      ]),
    );

    const outcome = configured.available
      ? await verify(identity)
      : { available: false as const, reason: configured.reason, failures: [], adopted: [] };
    const unmappedMounts = outcome.failures
      .flatMap((failure) => failure.unmappedMounts)
      .slice(0, MAX_UNMAPPED_MOUNTS);
    const common = {
      usesOverride,
      virtualPrefixes: configuredScopes.map((scope) => scope.virtualPrefix),
      unmappedMounts,
      // Only meaningful when some other scope survived; with nothing
      // verified, `reason` already describes the whole identity.
      unverifiedPrefixes: outcome.available
        ? outcome.failures.map((failure) => failure.virtualPrefix)
        : [],
      unindexedPrefixes: overrideRecord?.unindexedPrefixes ?? [],
      warning: SCOPE_STATUS_WARNING,
    };
    const state = outcome.available
      ? { status: "available" as const, reason: "ok" as const }
      : { status: "unavailable" as const, reason: outcome.reason };

    return isAdmin
      ? {
          ...common,
          ...state,
          isAdmin: true,
          configuredRoots,
          mappings: configuredScopes,
          overrides: overrideRecord?.scopes ?? [],
          adoptedMappings: outcome.adopted,
        }
      : { ...common, ...state, isAdmin: false };
  }

  /** Index roots plus the template root: the only roots a mapping may name. */
  async function knownRootNames(): Promise<Set<string>> {
    const knownRoots = new Set((deps.indexRoots ?? []).map((root) => root.name));
    for (const provider of await deps.providers.list()) {
      if (provider.type !== "sftpgo" || !provider.enabled) continue;
      try {
        knownRoots.add(parseHomeTemplate(sftpgoHomeTemplate(provider)).rootName);
      } catch {
        // An unparsable template is reported by `configuredMappings`; it
        // contributes no extra known root here.
      }
    }
    return knownRoots;
  }

  async function mountMappings(): Promise<readonly MountMapping[]> {
    return deps.mountMappings.get();
  }

  async function setMountMappings(mappings: readonly MountMapping[]): Promise<void> {
    validateMountMappings(mappings, { knownRoots: await knownRootNames() });
    await deps.mountMappings.set(mappings);
    // Adoption is decided per identity from these, so every cached outcome is stale.
    cache.invalidatePrefix("");
  }

  async function setOverrides(
    identity: Identity,
    scopes: readonly Scope[],
    unindexedPrefixes: readonly string[] = [],
  ): Promise<void> {
    const knownRoots = await knownRootNames();
    validateScopeOverrides(scopes, unindexedPrefixes, { knownRoots });
    if (scopes.length === 0 && unindexedPrefixes.length === 0) {
      await deps.overrides.reset(identity.id);
    } else {
      await deps.overrides.set(identity.id, scopes, unindexedPrefixes);
    }
    cache.invalidatePrefix(`${identity.id}:`);
  }

  return {
    configuredMappings,
    verifiedIndexScopes,
    status,
    setOverrides,
    mountMappings,
    setMountMappings,
  };
}
