import type { Pool } from "pg";
import { BACKUP_GATE } from "./registry.js";
import { ignoreCleanupError } from "./streams.js";
/** Every fdrive-owned blob writer holds this lock until bytes and references are durable. */
export async function withBackupWriter<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("set lock_timeout = '30s'");
    await client.query("select pg_advisory_lock_shared($1)", [BACKUP_GATE]);
    locked = true;
    return await work();
  } finally {
    if (locked)
      await client
        .query("select pg_advisory_unlock_shared($1)", [BACKUP_GATE])
        .catch(ignoreCleanupError);
    await client.query("reset lock_timeout").catch(ignoreCleanupError);
    client.release();
  }
}
