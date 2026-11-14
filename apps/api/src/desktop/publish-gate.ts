/** A precondition of safe publication that the deployment does not meet. */
export type PublishGate = "publish_lock";

/**
 * Which preconditions of publishing Mac writes are unmet; empty when they may
 * be published at all.
 *
 * fdrive serializes its own Mac writers: the per-identity publish lock plus
 * the destination recheck performed immediately before the rename is the
 * contract (see docs/MACOS.md). Without the lock a deployment stays read-only
 * rather than publishing unserialized.
 */
export function missingPublishGates(serialized: boolean): readonly PublishGate[] {
  return serialized ? [] : ["publish_lock"];
}
