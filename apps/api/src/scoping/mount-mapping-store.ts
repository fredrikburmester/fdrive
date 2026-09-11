import { MAX_MOUNT_MAPPINGS, MountMapping } from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import { ScopeOverrideValidationError } from "./validate-overrides.ts";

export type { MountMapping } from "@fdrive/contracts";

/** The stored shape of the global folder-level mappings, versioned for future migration. */
export interface MountMappingRecord {
  readonly version: 1;
  readonly mappings: readonly MountMapping[];
}

/** The `SettingsRepo` key the folder-level mappings are stored under. */
export const MOUNT_MAPPINGS_SETTINGS_KEY = "mount_mappings";

/**
 * Persists the folder-level mappings (`docs/SCOPING.md`):
 * one list for the whole installation, keyed by the mount's virtual path.
 * Which logins a mapping applies to is decided per login at verification
 * time by the resolver, never stored here.
 */
export interface MountMappingStore {
  get(): Promise<readonly MountMapping[]>;
  /** Replaces the list. Must already be validated by the caller. */
  set(mappings: readonly MountMapping[]): Promise<void>;
}

/**
 * Validates a candidate folder-mapping list: at most `MAX_MOUNT_MAPPINGS`,
 * each a well-formed `MountMapping` on a known root, no duplicate
 * `virtualPath`. Throws `ScopeOverrideValidationError` on the first
 * violation, reusing the override reasons so the account page maps them
 * to the same field-level sentences.
 */
export function validateMountMappings(
  mappings: readonly MountMapping[],
  options: { readonly knownRoots?: ReadonlySet<string> } = {},
): void {
  if (mappings.length > MAX_MOUNT_MAPPINGS) {
    throw new ScopeOverrideValidationError(
      "too_many",
      `at most ${MAX_MOUNT_MAPPINGS} folder mappings are allowed`,
    );
  }
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const parsed = MountMapping.safeParse(mapping);
    if (!parsed.success) {
      throw new ScopeOverrideValidationError(
        "invalid_mapping",
        `invalid folder mapping: ${parsed.error.message}`,
      );
    }
    if (options.knownRoots !== undefined && !options.knownRoots.has(parsed.data.rootName)) {
      throw new ScopeOverrideValidationError(
        "unknown_root",
        `unknown root: ${parsed.data.rootName}`,
      );
    }
    if (seen.has(parsed.data.virtualPath)) {
      throw new ScopeOverrideValidationError(
        "duplicate_virtual_prefix",
        `duplicate virtualPath: ${parsed.data.virtualPath}`,
      );
    }
    seen.add(parsed.data.virtualPath);
  }
}

/** Builds a `MountMappingStore` over the generic `app.settings` table; an absent row means no mappings. */
export function createSettingsMountMappingStore(
  settings: Pick<SettingsRepo, "get" | "set">,
): MountMappingStore {
  return {
    async get() {
      const stored = await settings.get<MountMappingRecord>(MOUNT_MAPPINGS_SETTINGS_KEY);
      return stored?.mappings ?? [];
    },
    async set(mappings) {
      const record: MountMappingRecord = { version: 1, mappings };
      await settings.set(MOUNT_MAPPINGS_SETTINGS_KEY, record);
    },
  };
}

/** An in-memory `MountMappingStore`, for tests. */
export function createInMemoryMountMappingStore(
  initial: readonly MountMapping[] = [],
): MountMappingStore {
  let current: readonly MountMapping[] = initial;
  return {
    async get() {
      return current;
    },
    async set(mappings) {
      current = mappings;
    },
  };
}
