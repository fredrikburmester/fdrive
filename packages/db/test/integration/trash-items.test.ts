import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it, vi } from "vitest";
import {
  createAccessRepo,
  createDb,
  createDesktopRepo,
  createRepos,
  createTrashItemRepo,
  migrate,
  trashItemChanges,
} from "../../src/index.js";
import { trashItems } from "../../src/schema/app.js";

it("keeps Trash's rows: listed once there, settled once, and in one transaction with access", {
  timeout: 180_000,
}, async () => {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const main = createDb(container.getConnectionUri());
  const first = createDb(container.getConnectionUri(), { max: 2 });
  const second = createDb(container.getConnectionUri(), { max: 2 });
  try {
    await migrate(main.db);
    const repos = createRepos(main.db);
    const account = await repos.accounts.create({ displayName: "Alice" });
    const alice = await repos.identities.create({ accountId: account.id, username: "alice" });
    const bobAccount = await repos.accounts.create({ displayName: "Bob" });
    const bob = await repos.identities.create({ accountId: bobAccount.id, username: "bob" });
    const trash = createTrashItemRepo(main.db);
    const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
    const item = (name: string, day: number, movingFrom = `/${name}`) => ({
      identityId: alice.id,
      originalPath: `/docs/${name}`,
      name,
      kind: "file" as const,
      size: 3,
      deletedAt: at(day),
      movingFrom,
    });

    // On its way, an item is nowhere a reader looks, but where a settler does.
    const report = await trash.begin(item("report.pdf", 2));
    expect(report).toMatchObject({ identityId: alice.id, movingFrom: "/report.pdf", size: 3 });
    expect(await trash.get(alice.id, report.id)).toBeNull();
    expect((await trash.list(alice.id, 10)).items).toEqual([]);
    expect((await trash.pending()).map((row) => row.id)).toEqual([report.id]);

    // It arrives in the file operation's transaction, once.
    const access = createAccessRepo(first.db);
    expect(
      await access.run([], (_follow, changes) =>
        changes.entered(report.id, `/.trash/${report.id}/report.pdf`),
      ),
    ).toBe(true);
    expect(
      await access.run([], (_follow, changes) =>
        changes.entered(report.id, `/.trash/${report.id}/report.pdf`),
      ),
    ).toBe(false);
    const { movingFrom: _, ...arrived } = report;
    expect(await trash.get(alice.id, report.id)).toEqual(arrived);
    expect(await trash.get(bob.id, report.id)).toBeNull();
    expect(await trash.pending()).toEqual([]);

    // A transaction that fails keeps nothing.
    const kept = await trash.begin(item("kept.txt", 1));
    await expect(
      access.run([], async (_follow, changes) => {
        await changes.entered(kept.id, `/.trash/${kept.id}/kept.txt`);
        throw new Error("the rename failed");
      }),
    ).rejects.toThrow("the rename failed");
    expect(await trash.get(alice.id, kept.id)).toBeNull();
    // Given up, it is gone; a row that arrived is never given up.
    await trash.abandon(kept.id);
    await trash.abandon(report.id);
    expect(await trash.pending()).toEqual([]);
    expect(await trash.get(alice.id, report.id)).not.toBeNull();

    // Two settlers race: one finds it on its way, the other finds it settled.
    const raced = await trash.begin(item("raced.txt", 3));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const slow = createAccessRepo(first.db).run([], async (_follow, changes) => {
      const won = await changes.entered(raced.id, `/.trash/${raced.id}/raced.txt`);
      locked();
      await held;
      return won;
    });
    await holding;
    let fastDone = false;
    const fast = createAccessRepo(second.db)
      .run([], (_follow, changes) => changes.entered(raced.id, `/.trash/${raced.id}/raced.txt`))
      .finally(() => {
        fastDone = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // It waits for the first to end rather than settle the item a second time.
    expect(fastDone).toBe(false);
    release();
    expect([await slow, await fast]).toEqual([true, false]);

    // Listing is newest first, one query however many there are.
    const many = Array.from({ length: 3000 }, (_, n) => ({
      ...item(`many-${n}.txt`, 4),
      deletedAt: new Date(at(4).getTime() + n),
      movingFrom: null,
    }));
    for (let start = 0; start < many.length; start += 1000)
      await main.db.insert(trashItems).values(many.slice(start, start + 1000));
    const query = vi.spyOn(main.pool, "query");
    const page = await trash.list(alice.id, 2500);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    expect(page.truncated).toBe(true);
    expect(page.items).toHaveLength(2500);
    expect(page.items[0]?.name).toBe("many-2999.txt");
    expect((await trash.list(alice.id, 10_000)).items.at(-1)?.id).toBe(report.id);
    expect((await trash.list(bob.id, 10)).items).toEqual([]);

    // What retention deletes: older than the cutoff, oldest first.
    expect((await trash.expired(alice.id, at(4))).map((row) => row.id)).toEqual([
      report.id,
      raced.id,
    ]);
    expect(await trash.expired(bob.id, at(30))).toEqual([]);

    // Restored or deleted for good, it leaves in the transaction.
    await access.run([], (_follow, changes) => changes.left(raced.id));
    expect(await trash.get(alice.id, raced.id)).toBeNull();

    // A Mac write keeps Trash's row with its receipt.
    const desktop = createDesktopRepo(main.db);
    const mac = await trash.begin(item("mac.txt", 6));
    const operation = randomUUID();
    await desktop.reserve({
      id: operation,
      identityId: alice.id,
      accountId: account.id,
      requestHash: "mac-trash",
      state: "ready",
      request: {
        kind: "move",
        activityAction: "file.trash",
        activityPath: "/mac.txt",
        activityTarget: "/.trash",
        activityKind: "file",
      },
    });
    await desktop.transition(alice.id, account.id, operation, "ready", "committing");
    expect(
      await desktop.complete(
        alice.id,
        account.id,
        operation,
        { item: null },
        { from: "/mac.txt", to: `/.trash/${mac.id}/mac.txt`, directory: false, trash: true },
        null,
        { entered: mac.id, leaf: `/.trash/${mac.id}/mac.txt` },
      ),
    ).toBe(true);
    expect(await trash.get(alice.id, mac.id)).not.toBeNull();
    const back = randomUUID();
    await desktop.reserve({
      id: back,
      identityId: alice.id,
      accountId: account.id,
      requestHash: "mac-restore",
      state: "ready",
      request: {
        kind: "move",
        activityAction: "file.restore",
        activityPath: `/.trash/${mac.id}/mac.txt`,
        activityTarget: "/mac.txt",
        activityKind: "file",
      },
    });
    await desktop.transition(alice.id, account.id, back, "ready", "committing");
    await desktop.complete(
      alice.id,
      account.id,
      back,
      { item: null },
      { from: "/mac.txt", to: "/mac.txt", directory: false, trash: false, restored: true },
      null,
      { left: mac.id },
    );
    expect(await trash.get(alice.id, mac.id)).toBeNull();

    // Changes outside a transaction runner work on any executor.
    const direct = await trash.begin(item("direct.txt", 7));
    expect(await trashItemChanges(main.db).entered(direct.id, "/.trash/x/direct.txt")).toBe(true);
  } finally {
    await Promise.all([main.pool.end(), first.pool.end(), second.pool.end()]);
    await container.stop();
  }
});
