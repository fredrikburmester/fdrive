import type { Pool } from "pg";

/**
 * Serializes the storage publication phase of desktop writes for one identity.
 *
 * This is a *session* advisory lock on a dedicated pooled connection, not the
 * transaction lock the registry uses in `desktop.ts`: the critical section is
 * mostly storage round trips, plus the holder's own short queries on the main
 * pool to re-prove its authority, and wrapping them in an open transaction would
 * pin a backend and block vacuum for their duration. A session lock is released
 * by the backend when the connection dies, so an API process that crashes
 * mid-publish frees the identity without operator action.
 *
 * Give it a pool of its own. A holder keeps a connection for the whole critical
 * section — storage round trips, and for a replace-upload a digest of the file
 * being replaced — and runs its own queries meanwhile, so on a shared pool a
 * saturated one would leave holders unable to finish and release. Waiters keep
 * nothing: the connection goes back between attempts, so the pool's bound sizes
 * concurrent publications rather than everyone queued behind them.
 *
 * It fences desktop commits against each other and nothing else. Web mutations
 * (`apps/api/src/fs/routes.ts`), Collabora saves (`apps/api/src/office/writes.ts`),
 * the OCR pass and any client writing the storage directly never take it, because
 * their publication *is* their transfer and serializing that is what this design
 * exists to avoid. A desktop commit is protected from all of them by proving the
 * destination's content inside the section instead; see
 * `docs/plans/STOCK-SFTPGO-WRITES.md`.
 */
export type DesktopPublishLock = <T>(identityId: string, run: () => Promise<T>) => Promise<T>;

/** Raised when the identity could not be taken within the wait. Retryable. */
export class DesktopPublishBusyError extends Error {
  constructor(identityId: string, options?: { cause: unknown }) {
    super(`Publication is busy for identity ${identityId}`, options);
    this.name = "DesktopPublishBusyError";
  }
}

export interface DesktopPublishLockOptions {
  /** Receives the reason a connection could not be checked out; the resulting
   * busy error reaches the client as a retryable status that carries no cause. */
  readonly onConnectError?: (cause: unknown) => void;
  /** Total time to wait for a busy identity before giving up. */
  readonly waitMs?: number;
  /** Delay between acquisition attempts. */
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const KEY = (identityId: string) => JSON.stringify(["desktop-publish", identityId]);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A caller that never releases would hold the identity forever, so acquisition
 * is bounded and reports a retryable failure instead of blocking indefinitely.
 */
export function createDesktopPublishLock(
  pool: Pool,
  options: DesktopPublishLockOptions = {},
): DesktopPublishLock {
  const waitMs = options.waitMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  return async (identityId, run) => {
    const key = KEY(identityId);
    const deadline = now() + waitMs;
    for (;;) {
      // Checked out per attempt and given back again while waiting. A session lock
      // has to be taken and released on one connection, but *waiting* for one owns
      // nothing, and holding a connection across the wait would make the pool's
      // bound cover waiters as well as holders — so a single slow identity could
      // refuse publication to every other identity in the deployment.
      //
      // Reaching the lock at all can fail: a bounded pool refuses once it is
      // saturated, whichever identities hold it. Publication has not started, so
      // the caller can retry — report that rather than a server error, and hand
      // the cause to the log because the client's 429 will not carry it.
      const client = await pool.connect().catch((cause: unknown) => {
        options.onConnectError?.(cause);
        throw new DesktopPublishBusyError(identityId, { cause });
      });
      const held = await client
        .query<{ held: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as held", [
          key,
        ])
        .then((result) => result.rows[0]?.held === true)
        .catch((error: unknown) => {
          client.release(error as Error);
          throw error;
        });
      if (held) {
        try {
          return await run();
        } finally {
          // A failed unlock means the session is unusable; destroy it rather than
          // return a connection that still owns the identity to the pool.
          await client
            .query("select pg_advisory_unlock(hashtextextended($1, 0))", [key])
            .then(() => client.release())
            .catch((error: unknown) => client.release(error as Error));
        }
      }
      client.release();
      if (now() >= deadline) throw new DesktopPublishBusyError(identityId);
      await sleep(pollMs);
    }
  };
}
