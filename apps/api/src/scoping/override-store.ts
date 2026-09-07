import type { Scope } from "@fdrive/core";
import type { SettingsRepo } from "@fdrive/db";

/** The stored shape of one identity's scope override, versioned for future migration. */
export interface ScopeOverrideRecord {
  readonly version: 1;
  readonly scopes: readonly Scope[];
}

/**
 * Persists per-identity scope overrides, keyed by identity id. No schema of
 * its own: `createSettingsScopeOverrideStore` below stores each identity's
 * override as one row in the existing generic `app.settings` key/value
 * table, so this chunk needs no migration.
 */
export interface ScopeOverrideStore {
  /** The stored override for `identityId`, or `null` when it has none (uses the plain template). */
  get(identityId: string): Promise<ScopeOverrideRecord | null>;
  /** Replaces the override for `identityId`. `scopes` must already be validated by the caller. */
  set(identityId: string, scopes: readonly Scope[]): Promise<void>;
  /** Removes the override for `identityId`, so it falls back to the plain template-derived home scope. */
  reset(identityId: string): Promise<void>;
}

/** The `SettingsRepo` key one identity's scope override is stored under. */
export function scopeOverrideSettingsKey(identityId: string): string {
  return `identity_scope:${identityId}`;
}

/**
 * Builds a `ScopeOverrideStore` over the existing `SettingsRepo` (see
 * `packages/db/src/repos/types.ts`), one row per identity keyed
 * `identity_scope:<identityId>`. `reset` stores an explicit `null` value
 * rather than deleting the row, since `SettingsRepo` has no delete
 * operation; `get` treats a stored `null` the same as no row.
 */
export function createSettingsScopeOverrideStore(
  settings: Pick<SettingsRepo, "get" | "set">,
): ScopeOverrideStore {
  return {
    async get(identityId) {
      return settings.get<ScopeOverrideRecord>(scopeOverrideSettingsKey(identityId));
    },
    async set(identityId, scopes) {
      const record: ScopeOverrideRecord = { version: 1, scopes };
      await settings.set(scopeOverrideSettingsKey(identityId), record);
    },
    async reset(identityId) {
      await settings.set(scopeOverrideSettingsKey(identityId), null);
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
    async set(identityId, scopes) {
      byIdentity.set(identityId, { version: 1, scopes });
    },
    async reset(identityId) {
      byIdentity.delete(identityId);
    },
  };
}
