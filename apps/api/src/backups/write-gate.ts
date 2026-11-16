import { withDatabaseWrite } from "@fdrive/backup";
import type { Pool } from "pg";

/**
 * Runs one write so that a backup's database snapshot holds all of it or
 * none (`withDatabaseWrite`): from `hold()` to its end, the write holds the
 * backups' snapshot gate. A write calls `hold()` where it starts changing the
 * files folder or the database in more than one step, never while a client's
 * body arrives, so the gate is held only for that short section.
 */
export type WriteGate = <T>(work: (hold: () => Promise<void>) => Promise<T>) => Promise<T>;

/** Without backups no snapshot is taken, so a write holds nothing. */
export const ungated: WriteGate = (work) => work(async () => undefined);

/** The gate on `pool`, the API's write gate pool, while backups are configured. */
export function writeGate(pool: Pool): WriteGate {
  return (work) => withDatabaseWrite(pool, work);
}

/** Runs `work` as one write that holds the gate from its start: work with no body to wait for. */
export function gated<T>(gate: WriteGate, work: () => Promise<T>): Promise<T> {
  return gate(async (hold) => {
    await hold();
    return work();
  });
}
