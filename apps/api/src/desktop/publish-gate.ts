import type { StorageProvider } from "@fdrive/core";

/** A precondition of safe publication that the deployment does not meet. */
export type PublishGate = "storage" | "publish_lock";

/**
 * Which preconditions of publishing to this storage are unmet; empty when it
 * may be published to at all.
 *
 * Two contracts qualify. A storage-enforced lease fences every writer the
 * storage itself sees. Failing that, `optimisticPublish` accepts fdrive-side
 * serialization plus the destination recheck performed immediately before the
 * rename — which requires that serialization to actually be configured, so a
 * deployment without the publish lock stays read-only rather than silently
 * dropping to an unserialized write.
 */
export function missingPublishGates(
  storage: StorageProvider,
  serialized: boolean,
): readonly PublishGate[] {
  if (storage.withWriteLease !== undefined) return [];
  if (storage.optimisticPublish !== true) return ["storage"];
  return serialized ? [] : ["publish_lock"];
}

/** Whether this storage may be published to at all; see `missingPublishGates`. */
export function publishesSafely(storage: StorageProvider, serialized: boolean): boolean {
  return missingPublishGates(storage, serialized).length === 0;
}
