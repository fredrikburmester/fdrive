import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { SNAPSHOT_GATE, withDatabaseWrite, withDatabaseWriter } from "../src/index.js";

/** A pool whose connections note every statement, failing the ones `fail` names. */
function fakePool(fail: { connect?: Error; statement?: [string, Error] } = {}) {
  const statements: string[] = [];
  const release = vi.fn();
  const connect = vi.fn(async () => {
    if (fail.connect) throw fail.connect;
    return {
      release,
      async query(text: string, values?: unknown[]) {
        statements.push(values === undefined ? text : `${text} ${values.join(",")}`);
        if (fail.statement && text.includes(fail.statement[0])) throw fail.statement[1];
        return { rows: [] };
      },
    };
  });
  return { pool: { connect } as unknown as Pool, connect, release, statements };
}

const TAKE = ["set lock_timeout = '30s'", `select pg_advisory_lock_shared($1) ${SNAPSHOT_GATE}`];
const LET_GO = [`select pg_advisory_unlock_shared($1) ${SNAPSHOT_GATE}`, "reset lock_timeout"];

describe("a write's hold on the snapshot gate", () => {
  it("holds nothing before its hold, and the gate from there to its end", async () => {
    const { pool, connect, release, statements } = fakePool();
    const result = await withDatabaseWrite(pool, async (hold) => {
      // An upload's body arriving: no connection, no gate.
      expect(connect).not.toHaveBeenCalled();
      await hold();
      await hold();
      expect(statements).toEqual(TAKE);
      return "published";
    });
    expect(result).toBe("published");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(statements).toEqual([...TAKE, ...LET_GO]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("takes no connection for a write that never holds", async () => {
    const { pool, connect } = fakePool();
    await expect(
      withDatabaseWrite(pool, async () => {
        throw new Error("the body never arrived");
      }),
    ).rejects.toThrow("the body never arrived");
    expect(connect).not.toHaveBeenCalled();
  });

  it("joins a write inside another, which keeps the gate until the outer one ends", async () => {
    const { pool, connect, statements } = fakePool();
    await withDatabaseWrite(pool, async () => {
      await withDatabaseWriter(pool, async () => undefined);
      // The inner write ended; the gate it took is the outer one's, still held.
      expect(statements).toEqual(TAKE);
      await withDatabaseWrite(pool, (hold) => hold());
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(statements).toEqual([...TAKE, ...LET_GO]);
  });

  it("refuses a hold once its write has ended, and a write begun later takes its own", async () => {
    const { pool, connect } = fakePool();
    let later: Promise<string> | undefined;
    let kept: (() => Promise<void>) | undefined;
    await withDatabaseWrite(pool, async (hold) => {
      kept = hold;
      // Work that outlives the write it started in.
      later = new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
        withDatabaseWriter(pool, async () => "own"),
      );
    });
    await expect(kept?.()).rejects.toThrow("This write has ended");
    expect(await later).toBe("own");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("lets go of its connection when the gate cannot be taken", async () => {
    const timeout = new Error("canceling statement due to lock timeout");
    const { pool, release, statements } = fakePool({
      statement: ["pg_advisory_lock_shared", timeout],
    });
    await expect(withDatabaseWriter(pool, async () => "never")).rejects.toBe(timeout);
    expect(statements).toEqual([...TAKE, "reset lock_timeout"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fails the write when no connection opens", async () => {
    const refused = new Error("connection refused");
    const { pool, release } = fakePool({ connect: refused });
    await expect(withDatabaseWriter(pool, async () => "never")).rejects.toBe(refused);
    expect(release).not.toHaveBeenCalled();
  });

  it("lets go of the gate when the write fails after holding it", async () => {
    const { pool, release, statements } = fakePool();
    await expect(
      withDatabaseWriter(pool, async () => {
        throw new Error("publish failed");
      }),
    ).rejects.toThrow("publish failed");
    expect(statements).toEqual([...TAKE, ...LET_GO]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
