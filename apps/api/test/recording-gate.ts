import type { Pool } from "pg";
import { type WriteGate, writeGate } from "../src/backups/write-gate.js";

/**
 * A write gate that notes in `steps` when a write first holds it and when
 * it lets go, as `withDatabaseWrite` holds and lets go of the snapshot gate.
 * `letGo` names the second step, so a test can say what was done by then.
 */
export function recordingGate(
  steps: string[],
  letGo: () => string = () => "gate let go",
): WriteGate {
  return async (work) => {
    let held = false;
    try {
      return await work(async () => {
        if (!held) steps.push("gate held");
        held = true;
      });
    } finally {
      if (held) steps.push(letGo());
    }
  };
}

/**
 * The API's real write gate (`writeGate`, writes inside writes joining)
 * over a pool that notes in `steps` when the snapshot gate is taken and let
 * go, and counts the connections it opens.
 */
export function recordingGateOnPool(steps: string[]): {
  gate: WriteGate;
  connections: () => number;
} {
  let connections = 0;
  const pool = {
    async connect() {
      connections++;
      return {
        release() {},
        async query(text: string) {
          if (text.includes("pg_advisory_lock_shared")) steps.push("gate held");
          if (text.includes("pg_advisory_unlock_shared")) steps.push("gate let go");
          return { rows: [] };
        },
      };
    },
  };
  return { gate: writeGate(pool as unknown as Pool), connections: () => connections };
}
