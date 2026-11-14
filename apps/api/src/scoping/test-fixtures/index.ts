import { type FileEntry, makeEntry, type ProviderModule, type StorageProvider } from "@fdrive/core";
import type { Identity, Provider } from "@fdrive/db";
import type { ProviderService, ResolvedProvider } from "../../providers/service.ts";

/** Test double only, for `apps/api/src/scoping/**` unit tests. */
export function buildIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: "identity-1",
    accountId: "account-1",
    providerId: "provider-1",
    externalUsername: "alice",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    lastLoginAt: null,
    ...overrides,
  };
}

/** Builds a local-folder provider row, enabled by default. */
export function buildProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-1",
    type: "local",
    baseUrl: "local",
    label: "",
    config: {},
    enabled: true,
    managedByEnv: true,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * A `ProviderService.get` over fixed rows, each resolved with `moduleFor`
 * its row (one module for every row by default).
 */
export function fakeProviders(
  rows: readonly Provider[],
  moduleFor: (row: Provider) => ProviderModule,
): Pick<ProviderService, "get"> {
  return {
    async get(id): Promise<ResolvedProvider | null> {
      const provider = rows.find((row) => row.id === id);
      return provider === undefined
        ? null
        : {
            provider,
            module: moduleFor(provider),
            instance: { id: provider.id, baseUrl: provider.baseUrl, config: provider.config },
          };
    },
  };
}

/** A `StorageProvider` with every method stubbed to throw, except any passed in `overrides`. */
export function fakeStorageProvider(overrides: Partial<StorageProvider> = {}): StorageProvider {
  const boom = async (): Promise<never> => {
    throw new Error("not implemented in fake storage provider");
  };
  return {
    list: overrides.list ?? ((async () => []) as StorageProvider["list"]),
    stat: overrides.stat ?? (boom as StorageProvider["stat"]),
    statFile: overrides.statFile ?? (boom as StorageProvider["statFile"]),
    download: overrides.download ?? (boom as StorageProvider["download"]),
    upload: overrides.upload ?? (boom as StorageProvider["upload"]),
    mkdir: overrides.mkdir ?? (boom as StorageProvider["mkdir"]),
    move: overrides.move ?? (boom as StorageProvider["move"]),
    copy: overrides.copy ?? (boom as StorageProvider["copy"]),
    deleteFile: overrides.deleteFile ?? (boom as StorageProvider["deleteFile"]),
    deleteDir: overrides.deleteDir ?? (boom as StorageProvider["deleteDir"]),
    deleteEmptyDir: overrides.deleteEmptyDir ?? (boom as StorageProvider["deleteEmptyDir"]),
    setModifiedAt:
      overrides.setModifiedAt ?? (boom as NonNullable<StorageProvider["setModifiedAt"]>),
    zip: overrides.zip ?? (boom as NonNullable<StorageProvider["zip"]>),
  };
}

/** A `FileEntry` under "/", for feeding `StorageProvider.list` fakes. */
export function fileEntry(name: string, kind: FileEntry["kind"] = "file"): FileEntry {
  return makeEntry("/", { name, kind, size: 0, modifiedAt: new Date("2024-01-01T00:00:00Z") });
}
