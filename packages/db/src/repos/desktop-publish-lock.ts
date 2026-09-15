import type { Pool } from "pg";

/**
 * Serializes the storage publication phase of desktop writes for one identity.
 *
 * This is a *session* advisory lock on a dedicated pooled connection, not the
 * transaction lock the registry uses in `desktop.ts`: the critical section is a
 * handful of storage round trips rather than database work, and wrapping them in
 * an open transaction would pin a backend and block vacuum for their duration. A
 * session lock is released by the backend when the connection dies, so an API
 * process that crashes mid-publish frees the identity without operator action.
 *
 * Give it a pool of its own. A connection is held for the whole critical section,
 * which is longer than a query even though it is far shorter than a transfer, and
 * the holder runs its own queries meanwhile — on a shared pool a saturated one
 * would leave holders unable to finish and release.
 *
 * It fences every writer fdrive mediates — desktop commits, web mutations, the
 * retention job and the OCR pass. It cannot fence a client writing the storage
 * directly; that residual is the accepted risk in `docs/plans/STOCK-SFTPGO-WRITES.md`.
 */
export type DesktopPublishLock = <T>(identityId: string, run: () => Promise<T>) => Promise<T>;

/** Raised when the identity could not be taken within the wait. Retryable. */
export class DesktopPublishBusyError extends Error {
  constructor(identityId: string, options?: { cause: unknown }) {
    super(`Another write is publishing for identity ${identityId}`, options);
    this.name = "DesktopPublishBusyError";
  }
}

export interface DesktopPublishLockOptions {
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
    // Reaching the lock at all can fail: a bounded pool refuses once it is
    // saturated. Publication has not started, so the caller can retry — report
    // that rather than a server error, and keep the cause for the log.
    const client = await pool.connect().catch((cause: unknown) => {
      throw new DesktopPublishBusyError(identityId, { cause });
    });
    let held = false;
    try {
      const deadline = now() + waitMs;
      for (;;) {
        const result = await client.query<{ held: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as held",
          [key],
        );
        if (result.rows[0]?.held) {
          held = true;
          break;
        }
        if (now() >= deadline) throw new DesktopPublishBusyError(identityId);
        await sleep(pollMs);
      }
      return await run();
    } finally {
      if (held) {
        // A failed unlock means the session is unusable; destroy it rather than
        // return a connection that still owns the identity to the pool.
        await client
          .query("select pg_advisory_unlock(hashtextextended($1, 0))", [key])
          .then(() => client.release())
          .catch((error: unknown) => client.release(error as Error));
      } else {
        client.release();
      }
    }
  };
}
