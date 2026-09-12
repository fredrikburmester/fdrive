import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CreateDbResult,
  createDb,
  createWopiLockRepo,
  migrate,
  WOPI_LOCK_TTL_MS,
  type WopiLockRepo,
} from "../../src/index.js";
import { wopiLocks } from "../../src/schema/app.js";

let container: StartedPostgreSqlContainer | undefined;
let first: CreateDbResult;
let second: CreateDbResult;
let a: WopiLockRepo;
let b: WopiLockRepo;
const now = new Date("2026-01-01T12:00:00Z");
const request = { fileId: "file", operation: "lock", lockId: "a", now } as const;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();
  first = createDb(container.getConnectionUri());
  second = createDb(container.getConnectionUri());
  await migrate(first.db);
  a = createWopiLockRepo(first.db);
  b = createWopiLockRepo(second.db);
});
afterAll(async () => {
  await Promise.allSettled([first?.close(), second?.close()]);
  await container?.stop();
});
beforeEach(async () => {
  await first.db.execute(sql`truncate app.wopi_locks`);
});

async function stored() {
  const [row] = await first.db.select().from(wopiLocks).where(eq(wopiLocks.fileId, "file"));
  return row;
}

describe("Postgres WOPI locks", () => {
  it("prunes expired locks in bounded batches while retaining live locks", async () => {
    await first.db.insert(wopiLocks).values(
      Array.from({ length: 101 }, (_, i) => ({
        fileId: `expired-${i}`,
        lockId: "old",
        expiresAt: now,
      })),
    );
    await a.apply(request);
    expect(await first.db.select().from(wopiLocks)).toHaveLength(2);
    expect(await a.get("file", now)).toBe("a");
    expect(await first.db.select().from(wopiLocks)).toHaveLength(1);
  });

  it("serializes two independent pools acquiring absent rows", async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const fileId = `absent-${attempt}`;
      const results = await Promise.all([
        a.apply({ ...request, fileId }),
        b.apply({ ...request, fileId, lockId: "b" }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const winner = results[0]?.ok ? "a" : "b";
      expect(results.find((result) => !result.ok)).toEqual({ ok: false, currentLock: winner });
      expect(await a.get(fileId, now)).toBe(winner);
    }
  });
  it("serializes competing relocks against the same old ID", async () => {
    await a.apply(request);
    const results = await Promise.all([
      a.apply({ ...request, operation: "relock", oldLockId: "a", lockId: "b" }),
      b.apply({ ...request, operation: "relock", oldLockId: "a", lockId: "c" }),
    ]);
    const winner = results[0]?.ok ? "b" : "c";
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, currentLock: winner });
    expect(await a.get("file", now)).toBe(winner);
  });
  it("refreshes matching locks and preserves rows on every wrong-lock operation", async () => {
    expect(await a.get("file", now)).toBeNull();
    await a.apply(request);
    const initial = await stored();
    for (const operation of ["lock", "refresh", "unlock", "relock"] as const) {
      expect(
        await b.apply({
          ...request,
          operation,
          lockId: "wrong",
          oldLockId: "wrong",
          now: new Date(now.getTime() + 100),
        }),
      ).toEqual({ ok: false, currentLock: "a" });
      expect(await stored()).toEqual(initial);
    }
    const later = new Date(now.getTime() + 1000);
    expect(await b.apply({ ...request, operation: "refresh", now: later })).toEqual({ ok: true });
    expect((await stored())?.expiresAt).toEqual(new Date(later.getTime() + WOPI_LOCK_TTL_MS));
    const latest = new Date(now.getTime() + 2000);
    expect(await a.apply({ ...request, now: latest })).toEqual({ ok: true });
    expect((await stored())?.expiresAt).toEqual(new Date(latest.getTime() + WOPI_LOCK_TTL_MS));
    expect(await b.apply({ ...request, operation: "unlock" })).toEqual({ ok: true });
    expect(await stored()).toBeUndefined();
  });
  it("treats expiry as absent and atomically replaces an expired row", async () => {
    await a.apply(request);
    const expiry = new Date(now.getTime() + WOPI_LOCK_TTL_MS);
    expect(await b.get("file", new Date(expiry.getTime() - 1))).toBe("a");
    expect(await b.get("file", expiry)).toBeNull();
    for (const operation of ["refresh", "unlock", "relock"] as const) {
      expect(await b.apply({ ...request, operation, oldLockId: "a", now: expiry })).toEqual({
        ok: false,
        currentLock: "",
      });
    }
    expect(await b.apply({ ...request, lockId: "b", now: expiry })).toEqual({ ok: true });
    expect(await a.get("file", expiry)).toBe("b");
    const later = new Date(expiry.getTime() + 1);
    expect(
      await a.apply({ ...request, operation: "relock", oldLockId: "b", lockId: "c", now: later }),
    ).toEqual({ ok: true });
    expect((await stored())?.expiresAt).toEqual(new Date(later.getTime() + WOPI_LOCK_TTL_MS));
  });
  it("keeps opaque identifiers separate and handles maximum lengths", async () => {
    const fileIds = ["x".repeat(4096), "é".repeat(2048), "file' ); delete from app.wopi_locks; --"];
    for (const fileId of fileIds) {
      expect(await a.apply({ ...request, fileId, lockId: "x".repeat(1024) })).toEqual({ ok: true });
      expect(await b.get(fileId, now)).toBe("x".repeat(1024));
    }
    expect(await a.get("file", now)).toBeNull();
  });
  it("validates before touching a closed pool", async () => {
    const disconnected = createDb("postgresql://unused:unused@127.0.0.1:1/unused");
    await disconnected.close();
    const repo = createWopiLockRepo(disconnected.db);
    await expect(repo.get("", now)).rejects.toThrow(TypeError);
    await expect(repo.apply({ ...request, lockId: "" })).rejects.toThrow(TypeError);
    await expect(repo.apply({ ...request, operation: "relock" })).rejects.toThrow("oldLockId");
  });
});

describe("Postgres callback transactions", () => {
  it("holds the advisory lock through asynchronous work and lets a waiting pool observe its commit", async () => {
    const entered = createSignal();
    const release = createSignal();
    const held = a.withFileLock("file", async (locked) => {
      expect(await locked.get(now)).toBeNull();
      await locked.apply(request);
      expect(await locked.get(now)).toBe("a");
      entered.resolve();
      await release.promise;
      return "saved";
    });
    await entered.promise;
    const next = b.apply({ ...request, lockId: "b" });
    try {
      await expect
        .poll(async () => {
          const rows = await first.db.execute<{ count: number }>(
            sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted`,
          );
          return rows.rows[0]?.count;
        })
        .toBe(1);
      expect(await a.apply({ ...request, fileId: "other" })).toEqual({ ok: true });
    } finally {
      release.resolve();
    }
    expect(await held).toBe("saved");
    expect(await next).toEqual({ ok: false, currentLock: "a" });
  });

  it("rolls back on throw and releases a waiting pool to acquire the absent lock", async () => {
    const entered = createSignal();
    const release = createSignal();
    const held = a.withFileLock("file", async (locked) => {
      await locked.apply(request);
      entered.resolve();
      await release.promise;
      throw new Error("upload failed");
    });
    const rejected = expect(held).rejects.toThrow("upload failed");
    await entered.promise;
    const next = b.apply({ ...request, lockId: "b" });
    release.resolve();
    await rejected;
    expect(await next).toEqual({ ok: true });
    expect(await a.get("file", now)).toBe("b");
    await expect(
      a.withFileLock("file", async (locked) => {
        await locked.apply({ ...request, operation: "unlock", lockId: "b" });
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await b.get("file", now)).toBe("b");
    await expect(a.withFileLock("", async () => 1)).rejects.toThrow(TypeError);
  });
});

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}
