import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type BoundWopiLockRepo,
  type CreateDbResult,
  createDb,
  createOfficeFileRepo,
  createOfficeWriteScope,
  createWopiLockRepo,
  migrate,
  type OfficeWriteContext,
  type OfficeWriteScope,
} from "../../src/index.js";
import { officeFiles, providers, wopiLocks } from "../../src/schema/app.js";

const providerId = "00000000-0000-0000-0000-000000000001";
const otherProviderId = "00000000-0000-0000-0000-000000000002";
const at = new Date("2026-09-06T12:00:00Z");
const location = { providerId, rootName: "root", path: "folder/file.docx" };
const move = { providerId, rootName: "root", from: "folder", to: "moved", at };
const request = { fileId: "file", operation: "lock", lockId: "lock", now: at } as const;
let container: StartedPostgreSqlContainer | undefined;
let first: CreateDbResult;
let second: CreateDbResult;
let observer: CreateDbResult;
let write: OfficeWriteScope;
let writeOther: OfficeWriteScope;
beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();
  const url = new URL(container.getConnectionUri());
  url.searchParams.set(
    "options",
    "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=8000",
  );
  first = createDb(url.toString(), { max: 2 });
  second = createDb(url.toString(), { max: 2 });
  observer = createDb(url.toString(), { max: 1 });
  await migrate(first.db);
  await first.db.insert(providers).values([
    { id: providerId, type: "sftpgo", baseUrl: "http://one" },
    { id: otherProviderId, type: "sftpgo", baseUrl: "http://two" },
  ]);
  write = createOfficeWriteScope(first.db);
  writeOther = createOfficeWriteScope(second.db);
});
afterAll(async () => {
  await Promise.allSettled([first?.close(), second?.close(), observer?.close()]);
  await container?.stop();
});
beforeEach(async () => {
  await first.db.execute(sql`truncate app.office_files, app.wopi_locks`);
});
function signal(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}
async function waitForAdvisoryWaiter(): Promise<void> {
  await expect
    .poll(
      async () => {
        const rows = await observer.db.execute<{ count: number }>(
          sql`select count(*)::integer as count from pg_locks where locktype='advisory' and not granted`,
        );
        return rows.rows[0]?.count;
      },
      { timeout: 2000 },
    )
    .toBe(1);
}

describe("office write transaction scope", () => {
  it("finishes nested registry/file locks with a two-connection pool whose other connection is waiting", async () => {
    const entered = signal();
    const release = signal();
    const order: string[] = [];
    let fileId = "";
    const firstWrite = write(providerId, async (scope) => {
      order.push("first enters");
      entered.resolve();
      await release.promise;
      return scope.locks.withFileLock("destination", () =>
        scope.locks.withFileLock("file", async (locked) => {
          const file = await scope.files.ensure(location);
          fileId = file.id;
          expect(await locked.get(at)).toBeNull();
          expect(await locked.apply(request)).toEqual({ ok: true });
          await scope.files.movePrefix(move);
          expect((await scope.files.get(file.id))?.path).toBe("moved/file.docx");
          order.push("first leaves");
          return file.id;
        }),
      );
    });
    await entered.promise;
    const secondWrite = write(providerId, async (scope) => {
      order.push("second enters");
      expect((await scope.files.get(fileId))?.path).toBe("moved/file.docx");
      expect(await scope.locks.get("file", at)).toBe("lock");
      const same = await scope.files.ensure({ ...location, path: "moved/file.docx" });
      return same.id;
    });
    const both = Promise.all([firstWrite, secondWrite]);
    const completed = expect(both).resolves.toEqual(expect.any(Array));
    try {
      await waitForAdvisoryWaiter();
      expect(first.pool.totalCount).toBe(2);
      expect(first.pool.waitingCount).toBe(0);
    } finally {
      release.resolve();
    }
    await completed;
    expect(await both).toEqual([fileId, fileId]);
    expect(order).toEqual(["first enters", "first leaves", "second enters"]);
    expect(first.pool.totalCount).toBe(2);
  }, 10000);

  it("rolls back registry replacements and lock rows together on callback failure", async () => {
    const files = createOfficeFileRepo(first.db);
    const original = await files.ensure(location);
    const replaced = await files.ensure({ ...location, path: "moved/file.docx" });
    await expect(
      write(providerId, async (scope) => {
        await scope.locks.withFileLock("file", async (locked) => {
          await locked.apply(request);
          await scope.files.ensure({ ...location, path: "new.docx" });
          await scope.files.movePrefix(move);
          throw new Error("storage failed");
        });
      }),
    ).rejects.toThrow("storage failed");
    expect(await files.get(original.id)).toEqual(original);
    expect(await files.get(replaced.id)).toEqual(replaced);
    expect(await first.db.select().from(officeFiles)).toHaveLength(2);
    expect(await first.db.select().from(wopiLocks)).toHaveLength(0);
    await writeOther(providerId, async (scope) => {
      await scope.files.movePrefix(move);
      expect(await scope.locks.apply(request)).toEqual({ ok: true });
    });
    expect(await files.get(replaced.id)).toBeNull();
    expect(await createWopiLockRepo(first.db).get("file", at)).toBe("lock");
  });

  it("serializes across independent pools but permits another provider", async () => {
    const entered = signal();
    const release = signal();
    const held = write(providerId, async (scope) => {
      await scope.files.ensure(location);
      entered.resolve();
      await release.promise;
      return "first";
    });
    await entered.promise;
    const waiting = writeOther(providerId, async (scope) => {
      expect(await scope.files.ensure(location)).toMatchObject(location);
      return "second";
    });
    const completed = expect(Promise.all([held, waiting])).resolves.toEqual(["first", "second"]);
    try {
      await waitForAdvisoryWaiter();
      await expect(
        writeOther(otherProviderId, async (scope) => {
          await scope.files.ensure({ ...location, providerId: otherProviderId });
          return "independent";
        }),
      ).resolves.toBe("independent");
    } finally {
      release.resolve();
    }
    await completed;
  });

  it("holds a scoped file lock against an ordinary request until transaction commit", async () => {
    const entered = signal();
    const release = signal();
    const held = write(providerId, (scope) =>
      scope.locks.withFileLock("file", async (locked) => {
        await locked.apply(request);
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    const ordinary = createWopiLockRepo(second.db).apply({ ...request, lockId: "competitor" });
    const completed = expect(Promise.all([held, ordinary])).resolves.toEqual([
      undefined,
      { ok: false, currentLock: "lock" },
    ]);
    try {
      await waitForAdvisoryWaiter();
    } finally {
      release.resolve();
    }
    await completed;
  });

  it("supports every scoped registry and lock operation while active", async () => {
    await write(providerId, async (scope) => {
      const file = await scope.files.ensure(location);
      expect(await scope.files.ensure(location)).toEqual(file);
      await scope.files.movePrefix({ ...move, to: "folder" });
      await scope.files.deletePrefix({ ...location, at });
      expect(await scope.files.get(file.id)).toBeNull();
      expect(await scope.locks.apply(request)).toEqual({ ok: true });
      expect(await scope.locks.apply({ ...request, operation: "refresh" })).toEqual({ ok: true });
      expect(await scope.locks.apply({ ...request, operation: "unlock" })).toEqual({ ok: true });
      expect(await scope.locks.get("file", at)).toBeNull();
    });
  });

  it("rejects all escaped repository methods and retained bound locks", async () => {
    const escaped = await write(providerId, async (scope) => {
      const bound = await scope.locks.withFileLock("file", async (locked) => locked);
      return { scope, bound };
    });
    await assertExpired(escaped.scope, escaped.bound);
    let failed: { scope: OfficeWriteContext; bound: BoundWopiLockRepo } | undefined;
    await expect(
      write(providerId, async (scope) => {
        const bound = await scope.locks.withFileLock("file", async (locked) => locked);
        failed = { scope, bound };
        throw new Error("failed callback");
      }),
    ).rejects.toThrow("failed callback");
    if (!failed) throw new Error("Missing escaped context");
    await assertExpired(failed.scope, failed.bound);
    expect(await first.db.select().from(officeFiles)).toHaveLength(0);
    expect(await first.db.select().from(wopiLocks)).toHaveLength(0);
  });

  it("validates provider IDs before taking any database connection", async () => {
    const closed = createDb("postgresql://unused:unused@127.0.0.1:1/unused");
    await closed.close();
    await expect(createOfficeWriteScope(closed.db)("bad", async () => "unused")).rejects.toThrow(
      TypeError,
    );
  });
});

async function assertExpired(scope: OfficeWriteContext, bound: BoundWopiLockRepo): Promise<void> {
  await expect(scope.files.ensure(location)).rejects.toThrow("scope has ended");
  await expect(scope.files.get(providerId)).rejects.toThrow("scope has ended");
  await expect(scope.files.movePrefix(move)).rejects.toThrow("scope has ended");
  await expect(scope.files.movePrefix({ ...move, to: move.from })).rejects.toThrow(
    "scope has ended",
  );
  await expect(scope.files.deletePrefix({ ...location, at })).rejects.toThrow("scope has ended");
  await expect(scope.locks.get("file", at)).rejects.toThrow("scope has ended");
  await expect(scope.locks.apply(request)).rejects.toThrow("scope has ended");
  await expect(scope.locks.withFileLock("file", async () => "unused")).rejects.toThrow(
    "scope has ended",
  );
  await expect(bound.get(at)).rejects.toThrow("scope has ended");
  await expect(bound.apply(request)).rejects.toThrow("scope has ended");
}
