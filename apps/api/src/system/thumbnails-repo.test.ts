import type { Db } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import { createThumbnailsRepo } from "./thumbnails-repo.js";

/**
 * A minimal stand-in for `Db` that only implements the `select(...).from(...)`
 * chain `createThumbnailsRepo` calls, resolving to `rows`. Good enough to
 * exercise both branches of `count()` without a real Postgres connection.
 */
function fakeDb(rows: ReadonlyArray<{ value: number }>): Db {
  return {
    select: () => ({
      from: () => Promise.resolve(rows),
    }),
  } as unknown as Db;
}

describe("createThumbnailsRepo: count", () => {
  it("returns the row's value when a count row is returned", async () => {
    const repo = createThumbnailsRepo(fakeDb([{ value: 42 }]));

    expect(await repo.count()).toBe(42);
  });

  it("returns 0 when no row is returned", async () => {
    const repo = createThumbnailsRepo(fakeDb([]));

    expect(await repo.count()).toBe(0);
  });
});
