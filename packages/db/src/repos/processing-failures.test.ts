import { describe, expect, it, vi } from "vitest";
import type { Db } from "../index.js";
import { createProcessingFailureReader } from "./processing-failures.js";

const at = new Date("2026-09-13T08:00:00Z");
const row = (id: number, resolvedAt: Date | null = null) => ({
  root: "photos",
  failure: {
    id,
    path: "photo.png",
    feature: "thumbnails",
    code: "DecodeError",
    message: "invalid image",
    operationId: "scan-1",
    attempts: 3,
    firstFailedAt: at,
    lastFailedAt: at,
    resolvedAt,
  },
});

function database(results: unknown[][]) {
  const where = vi.fn();
  const db = {
    select: vi.fn(() => {
      const result = results.shift();
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: (condition: unknown) => {
          where(condition);
          return query;
        },
        orderBy: () => query,
        groupBy: () => query,
        limit: () => query,
        // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return query;
    }),
  } as unknown as Db;
  return { db, where };
}

describe("failure query shaping", () => {
  it("uses a unique id cursor even when timestamps tie and returns counts independently", async () => {
    const { db, where } = database([
      [row(3), row(2)],
      [{ code: "DecodeError", count: 2 }],
      [{ count: 2 }],
      [{ count: 4 }],
    ]);
    const result = await createProcessingFailureReader(db)("thumbnails", {
      status: "open",
      limit: 1,
    });
    expect(result).toMatchObject({ total: 2, openCount: 4, nextCursor: 3 });
    expect(result.entries[0]).toMatchObject({
      root: "photos",
      firstFailedAt: at.toISOString(),
      resolvedAt: null,
      attempts: 3,
    });
    expect(where).toHaveBeenCalledTimes(4);
  });
  it("returns resolved entries and a terminal page", async () => {
    const { db } = database([[row(1, at)], [], [{ count: 1 }], [{ count: 0 }]]);
    const result = await createProcessingFailureReader(db)("thumbnails", {
      status: "resolved",
      before: 2,
      code: "DecodeError",
      limit: 3,
    });
    expect(result.entries[0]?.resolvedAt).toBe(at.toISOString());
    expect(result.nextCursor).toBeUndefined();
  });
  it("handles empty aggregates", async () => {
    const { db } = database([[], [], [], []]);
    expect(
      await createProcessingFailureReader(db)("textSearch", { status: "open", limit: 5 }),
    ).toEqual({ entries: [], groups: [], total: 0, openCount: 0 });
  });
});
