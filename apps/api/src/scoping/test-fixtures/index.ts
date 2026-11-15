import { type FileEntry, makeEntry, type StorageProvider } from "@fdrive/core";
import type { Identity } from "@fdrive/db";

/** Test double only, for `apps/api/src/scoping/**` unit tests. */
export function buildIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: "identity-1",
    accountId: "account-1",
    username: "alice",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    lastLoginAt: null,
    ...overrides,
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
    trash: overrides.trash ?? {
      put: boom,
      list: boom,
      restore: boom,
      purge: boom,
    },
  };
}

/** A `FileEntry` under "/", for feeding `StorageProvider.list` fakes. */
export function fileEntry(name: string, kind: FileEntry["kind"] = "file"): FileEntry {
  return makeEntry("/", { name, kind, size: 0, modifiedAt: new Date("2024-01-01T00:00:00Z") });
}
