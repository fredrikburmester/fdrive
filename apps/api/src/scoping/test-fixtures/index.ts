import type { IndexerDirectoryResponse } from "@fdrive/contracts";
import { type FileEntry, makeEntry, type StorageProvider } from "@fdrive/core";
import type { Identity } from "@fdrive/db";
import type { Connection, ConnectionStore } from "../../connection/store.ts";
import type { IndexerClient } from "../../system/indexer-client.ts";
import type { SidecarResult } from "../../system/sidecar-client.ts";

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

/** A `ConnectionStore` (or its `current`-only slice) always returning `connection`. */
export function fakeConnectionStore(
  connection: Connection | null,
): Pick<ConnectionStore, "current"> {
  return { current: async () => connection };
}

/**
 * A `Pick<IndexerClient, "directory">` whose responses are looked up by
 * `"<root>:<path>"`. An entry missing from `fixtures` reports unreachable,
 * so a test only has to describe the roots/paths it cares about.
 */
export function fakeIndexerDirectory(
  fixtures: ReadonlyMap<string, IndexerDirectoryResponse>,
): Pick<IndexerClient, "directory"> {
  return {
    async directory(root, path): Promise<SidecarResult<IndexerDirectoryResponse>> {
      const fixture = fixtures.get(`${root}:${path}`);
      if (fixture === undefined) {
        return { ok: false, reason: "unreachable", detail: `no fixture for ${root}:${path}` };
      }
      return { ok: true, data: fixture };
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
    statFile: overrides.statFile ?? (boom as StorageProvider["statFile"]),
    download: overrides.download ?? (boom as StorageProvider["download"]),
    upload: overrides.upload ?? (boom as StorageProvider["upload"]),
    mkdir: overrides.mkdir ?? (boom as StorageProvider["mkdir"]),
    move: overrides.move ?? (boom as StorageProvider["move"]),
    copy: overrides.copy ?? (boom as StorageProvider["copy"]),
    deleteFile: overrides.deleteFile ?? (boom as StorageProvider["deleteFile"]),
    deleteDir: overrides.deleteDir ?? (boom as StorageProvider["deleteDir"]),
    setModifiedAt: overrides.setModifiedAt ?? (boom as StorageProvider["setModifiedAt"]),
    zip: overrides.zip ?? (boom as StorageProvider["zip"]),
  };
}

/** A `FileEntry` under "/", for feeding `StorageProvider.list` fakes. */
export function fileEntry(name: string, kind: FileEntry["kind"] = "file"): FileEntry {
  return makeEntry("/", { name, kind, size: 0, modifiedAt: new Date("2024-01-01T00:00:00Z") });
}
