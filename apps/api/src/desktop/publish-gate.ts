import type { StorageProvider } from "@fdrive/core";

/**
 * Whether this storage may be published to at all.
 *
 * Two contracts qualify. A storage-enforced lease fences every writer the
 * storage itself sees. Failing that, `optimisticPublish` accepts fdrive-side
 * serialization plus the destination recheck performed immediately before the
 * rename — which requires that serialization to actually be configured, so a
 * deployment without the publish lock stays read-only rather than silently
 * dropping to an unserialized write.
 */
export function publishesSafely(storage: StorageProvider, serialized: boolean): boolean {
  if (storage.withWriteLease !== undefined) return true;
  return storage.optimisticPublish === true && serialized;
}
