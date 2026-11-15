import { join } from "node:path";
import { Client } from "pg";
import { INDEX_ROOT_NAME } from "./environment.js";

function fromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`fdrive e2e: ${name} is not set; global-setup exports it`);
  }
  return value;
}

/**
 * Where `virtualPath` in `username`'s files is on the host's disk, in the
 * shared run's local folder (`FDRIVE_STORAGE_ROOT`). Specs change files
 * here directly to act as a writer outside fdrive: the host, rsync, OCR.
 */
export function homePath(username: string, virtualPath = "/"): string {
  return join(fromEnv("E2E_STORAGE_ROOT"), username, virtualPath);
}

/**
 * Journals what the indexer's file watcher journals when it sees
 * `virtualPath` in `username`'s files change on disk: a row in
 * `idx.changes` with source `watcher`, appended under the journal's lock and
 * announced on `idx_changes`, as every writer does. The shared run has no
 * real indexer, so a spec that changes files through `homePath` reports the
 * change itself.
 */
export async function journalOutsideChange(username: string, virtualPath: string): Promise<void> {
  const client = new Client({ connectionString: fromEnv("E2E_DATABASE_URL") });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended('idx.changes', 0))");
    await client.query(
      `insert into idx.changes (root_id, path, source)
       select id, $2, 'watcher' from idx.roots where name = $1`,
      [INDEX_ROOT_NAME, `${username}${virtualPath}`],
    );
    await client.query("select pg_notify('idx_changes', $1)", [INDEX_ROOT_NAME]);
    await client.query("commit");
  } finally {
    await client.end();
  }
}
