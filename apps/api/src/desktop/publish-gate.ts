import type { StorageProvider } from "@fdrive/core";

/**
 * Whether this storage may be published to at all.
 *
 * Every storage qualifies once fdrive can serialize its own Mac writers: the
 * per-identity publish lock plus the destination recheck performed immediately
 * before the rename is the default contract, and no storage offers a primitive
 * that would make it optional (see docs/MACOS.md). A storage-enforced lease
 * (`withWriteLease`) is the stronger contract and fences every writer the
 * storage sees, so it needs no lock of its own. With neither, a deployment
 * stays read-only rather than publishing unserialized.
 */
export function publishesSafely(storage: StorageProvider, serialized: boolean): boolean {
  return storage.withWriteLease !== undefined || serialized;
}
