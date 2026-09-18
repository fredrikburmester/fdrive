import type { StorageProvider } from "@fdrive/core";

/** A precondition of safe publication that the deployment does not meet. */
export type PublishGate = "publish_lock";

/**
 * Which preconditions of publishing to this storage are unmet; empty when it
 * may be published to at all.
 *
 * Every storage qualifies once fdrive can serialize its own Mac writers: the
 * per-identity publish lock plus the destination recheck performed immediately
 * before the rename is the default contract, and no storage offers a primitive
 * that would make it optional (see docs/MACOS.md). A storage-enforced lease
 * (`withWriteLease`) is the stronger contract and fences every writer the
 * storage sees, so it needs no lock of its own. With neither, a deployment
 * stays read-only rather than publishing unserialized.
 */
export function missingPublishGates(
  storage: StorageProvider,
  serialized: boolean,
): readonly PublishGate[] {
  return storage.withWriteLease !== undefined || serialized ? [] : ["publish_lock"];
}

/** Whether this storage may be published to at all; see `missingPublishGates`. */
export function publishesSafely(storage: StorageProvider, serialized: boolean): boolean {
  return missingPublishGates(storage, serialized).length === 0;
}
