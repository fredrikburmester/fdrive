import { join } from "node:path";
import { Client } from "pg";

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
 * Sends the notification the indexer's file watcher sends on `idx_events`
 * when it sees `virtualPath` in `username`'s files change on disk. The shared
 * run has no real indexer, so a spec that changes files through `homePath`
 * reports the change itself.
 */
export async function notifyIndexer(
  kind: "created" | "changed" | "deleted",
  username: string,
  virtualPath: string,
): Promise<void> {
  const client = new Client({ connectionString: fromEnv("E2E_DATABASE_URL") });
  await client.connect();
  try {
    await client.query("select pg_notify('idx_events', $1)", [
      JSON.stringify({
        kind,
        path: `${username}${virtualPath}`,
        target_path: null,
        at: new Date().toISOString(),
      }),
    ]);
  } finally {
    await client.end();
  }
}
