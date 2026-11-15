import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { SNAPSHOT_GATE } from "./registry.js";
import { ignoreCleanupError } from "./streams.js";

interface Write {
  hold(): Promise<void>;
  ended: boolean;
}

/** The write that running work belongs to, which a write inside it joins. */
const writes = new AsyncLocalStorage<Write>();

/**
 * Runs `work`, one write, so that no capture's database snapshot holds part of it. From its
 * `hold()` to its end it holds the snapshot gate (`SNAPSHOT_GATE`), shared; `hold()` waits only
 * while a capture takes its snapshot, and gives up after 30 seconds. What `work` does before,
 * such as reading an upload's body, holds nothing. A write inside another joins it rather than
 * waiting for a second connection while it holds the first.
 */
export async function withDatabaseWrite<T>(
  pool: Pool,
  work: (hold: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const outer = writes.getStore();
  if (outer !== undefined && !outer.ended) return work(() => outer.hold());
  const gate: { client?: PoolClient; held?: Promise<void> } = {};
  const write: Write = {
    ended: false,
    hold() {
      if (write.ended) return Promise.reject(new Error("This write has ended"));
      gate.held ??= (async () => {
        const client = await pool.connect();
        gate.client = client;
        await client.query("set lock_timeout = '30s'");
        await client.query("select pg_advisory_lock_shared($1)", [SNAPSHOT_GATE]);
      })();
      return gate.held;
    },
  };
  try {
    return await writes.run(write, () => work(() => write.hold()));
  } finally {
    write.ended = true;
    const locked = await gate.held?.then(
      () => true,
      () => false,
    );
    const client = gate.client;
    if (client !== undefined) {
      if (locked)
        await client
          .query("select pg_advisory_unlock_shared($1)", [SNAPSHOT_GATE])
          .catch(ignoreCleanupError);
      await client.query("reset lock_timeout").catch(ignoreCleanupError);
      client.release();
    }
  }
}

/** A write (`withDatabaseWrite`) that holds the gate from its start. */
export function withDatabaseWriter<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  return withDatabaseWrite(pool, async (hold) => {
    await hold();
    return work();
  });
}
