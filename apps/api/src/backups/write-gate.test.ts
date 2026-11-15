import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { gated, ungated, writeGate } from "./write-gate.ts";

describe("the write gate", () => {
  it("holds nothing without backups", async () => {
    expect(
      await ungated(async (hold) => {
        await hold();
        return "written";
      }),
    ).toBe("written");
  });

  it("takes the snapshot gate on its pool from a write's hold to its end", async () => {
    const statements: string[] = [];
    const release = vi.fn();
    const connect = vi.fn(async () => ({
      release,
      async query(text: string) {
        statements.push(text);
        return { rows: [] };
      },
    }));
    const gate = writeGate({ connect } as unknown as Pool);
    await gate(async (hold) => {
      expect(connect).not.toHaveBeenCalled();
      await hold();
      expect(statements).toContain("select pg_advisory_lock_shared($1)");
    });
    expect(statements.at(-2)).toBe("select pg_advisory_unlock_shared($1)");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("holds the gate before work that has no body to wait for", async () => {
    const steps: string[] = [];
    const result = await gated(
      (work) =>
        work(async () => {
          steps.push("held");
        }),
      async () => {
        steps.push("work");
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(steps).toEqual(["held", "work"]);
  });
});
