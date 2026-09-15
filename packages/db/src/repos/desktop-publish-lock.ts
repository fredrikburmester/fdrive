import type { Pool } from "pg";

/**
 * Serializes the storage publication phase of desktop writes for one identity.
 *
 * This is a *session* advisory lock on a dedicated pooled connection, not the
 * transaction lock the registry uses in `desktop.ts`: publication spans several
 * storage round trips, and holding an open transaction across them would pin a
 * backend and block vacuum for the length of a transfer. A session lock is
 * released by the backend when the connection dies, so an API process that
 * crashes mid-publish frees the identity without operator action.
 *
 * It fences every writer fdrive mediates — desktop commits, web mutations, the
 * retention job and the OCR pass. It cannot fence a client writing the storage
 * directly; that residual is the accepted risk in `docs/plans/STOCK-SFTPGO-WRITES.md`.
 */
export type DesktopPublishLock = <T>(identityId: string, run: () => Promise<T>) => Promise<T>;

/** Raised when another writer held the identity for the whole wait. Retryable. */
export class DesktopPublishBusyError extends Error {
  constructor(identityId: string) {
    super(`Another write is publishing for identity ${identityId}`);
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
    const client = await pool.connect();
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
