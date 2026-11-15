import type { Pool } from "pg";
import { SNAPSHOT_GATE } from "./registry.js";
import { ignoreCleanupError } from "./streams.js";
/**
 * Runs `work`, such as one mutating API request, so that no capture's database snapshot holds
 * half of it. It waits only while a capture takes that snapshot (`SNAPSHOT_GATE`), and gives up
 * after 30 seconds.
 */
export async function withDatabaseWriter<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("set lock_timeout = '30s'");
    await client.query("select pg_advisory_lock_shared($1)", [SNAPSHOT_GATE]);
    locked = true;
    return await work();
  } finally {
    if (locked)
      await client
        .query("select pg_advisory_unlock_shared($1)", [SNAPSHOT_GATE])
        .catch(ignoreCleanupError);
    await client.query("reset lock_timeout").catch(ignoreCleanupError);
    client.release();
  }
}
