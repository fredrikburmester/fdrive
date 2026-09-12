import type { Scope } from "@fdrive/core";
import type { SettingsRepo } from "@fdrive/db";

/**
 * The stored shape of one identity's scope override. Version 2 added
 * `unindexedPrefixes`; a version 1 record (scopes only) is still read and
 * reported as having none, so no migration is needed.
 */
export interface ScopeOverrideRecord {
  readonly version: 2;
  readonly scopes: readonly Scope[];
  /** Virtual prefixes acknowledged as present but not indexed; see `SetIdentityScopeRequest`. */
  readonly unindexedPrefixes: readonly string[];
}

/** A record as it may exist on disk: version 1 (no `unindexedPrefixes`) or version 2. */
export type StoredScopeOverrideRecord =
  | { readonly version: 1; readonly scopes: readonly Scope[] }
  | ScopeOverrideRecord;

/**
 * Upgrades a stored record of either version to the current in-memory
 * shape. A record with nothing in it reads as `null`: an empty override is
 * the same as no override, and it is also how `reset` is persisted, since
 * `app.settings.value` is `NOT NULL` and cannot hold a JSON `null`.
 */
export function normalizeScopeOverrideRecord(
  stored: StoredScopeOverrideRecord | null,
): ScopeOverrideRecord | null {
  if (stored === null) return null;
  const unindexedPrefixes = stored.version === 2 ? stored.unindexedPrefixes : [];
  if (stored.scopes.length === 0 && unindexedPrefixes.length === 0) return null;
  return { version: 2, scopes: stored.scopes, unindexedPrefixes };
}

/** The record `reset` writes: nothing mapped, nothing acknowledged, read back as `null`. */
export const EMPTY_SCOPE_OVERRIDE_RECORD: ScopeOverrideRecord = {
  version: 2,
  scopes: [],
  unindexedPrefixes: [],
};

/**
 * Persists per-identity scope overrides, keyed by identity id. No schema of
 * its own: `createSettingsScopeOverrideStore` below stores each identity's
 * override as one row in the existing generic `app.settings` key/value
 * table, so this chunk needs no migration.
 */
export interface ScopeOverrideStore {
  /** The stored override for `identityId`, or `null` when it has none (uses the plain template). */
  get(identityId: string): Promise<ScopeOverrideRecord | null>;
  /** Replaces the override for `identityId`. Both lists must already be validated by the caller. */
  set(
    identityId: string,
    scopes: readonly Scope[],
    unindexedPrefixes: readonly string[],
    accountId?: string,
  ): Promise<void>;
  /** Removes the override for `identityId`, so it falls back to the plain template-derived home scope. */
  reset(identityId: string, accountId?: string): Promise<void>;
}

/** The `SettingsRepo` key one identity's scope override is stored under. */
export function scopeOverrideSettingsKey(identityId: string): string {
  return `identity_scope:${identityId}`;
}

/**
 * Builds a `ScopeOverrideStore` over the existing `SettingsRepo` (see
 * `packages/db/src/repos/types.ts`), one row per identity keyed
 * `identity_scope:<identityId>`. `reset` stores an empty record rather than
 * deleting the row, since `SettingsRepo` has no delete operation and the
 * column rejects a JSON `null`; `get` reads an empty record as no row.
 */
export function createSettingsScopeOverrideStore(
  settings: Pick<SettingsRepo, "get" | "set">,
  withOwnedIdentity?: (
    accountId: string,
    identityId: string,
    write: (settings: Pick<SettingsRepo, "set">) => Promise<void>,
  ) => Promise<void>,
): ScopeOverrideStore {
  const persist = async (identityId: string, record: ScopeOverrideRecord, accountId?: string) => {
    const write = (repo: Pick<SettingsRepo, "set">) =>
      repo.set(scopeOverrideSettingsKey(identityId), record);
    if (withOwnedIdentity !== undefined) {
      if (accountId === undefined) throw new Error("scope write requires an owner");
      await withOwnedIdentity(accountId, identityId, write);
    } else await write(settings);
  };
  return {
    async get(identityId) {
      const stored = await settings.get<StoredScopeOverrideRecord>(
        scopeOverrideSettingsKey(identityId),
      );
      return normalizeScopeOverrideRecord(stored);
    },
    async set(identityId, scopes, unindexedPrefixes, accountId) {
      const record: ScopeOverrideRecord = { version: 2, scopes, unindexedPrefixes };
      await persist(identityId, record, accountId);
    },
    async reset(identityId, accountId) {
      await persist(identityId, EMPTY_SCOPE_OVERRIDE_RECORD, accountId);
    },
  };
}

/** An in-memory `ScopeOverrideStore`, for tests. */
export function createInMemoryScopeOverrideStore(): ScopeOverrideStore {
  const byIdentity = new Map<string, ScopeOverrideRecord>();
  return {
    async get(identityId) {
      return byIdentity.get(identityId) ?? null;
    },
    async set(identityId, scopes, unindexedPrefixes) {
      if (scopes.length === 0 && unindexedPrefixes.length === 0) {
        byIdentity.delete(identityId);
        return;
      }
      byIdentity.set(identityId, { version: 2, scopes, unindexedPrefixes });
    },
    async reset(identityId) {
      byIdentity.delete(identityId);
    },
  };
}
