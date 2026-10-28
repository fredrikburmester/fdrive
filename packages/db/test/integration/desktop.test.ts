import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createDb, createDesktopRepo, createRepos, migrate } from "../../src/index.js";

it("coordinates desktop identities and operation receipts across independent PostgreSQL pools", {
  timeout: 180_000,
}, async () => {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const first = createDb(container.getConnectionUri());
  const second = createDb(container.getConnectionUri());
  try {
    await migrate(first.db);
    const repos = createRepos(first.db);
    const account = await repos.accounts.create({ displayName: "Desktop" });
    const provider = await repos.providers.ensure({
      type: "webdav",
      baseUrl: "http://desktop.test/dav",
    });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    const other = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "bob",
    });
    const a = createDesktopRepo(first.db),
      b = createDesktopRepo(second.db);
    const [left, right] = await Promise.all([
      a.ensure(identity.id, "/å🚀_%", "dir"),
      b.ensure(identity.id, "/å🚀_%", "dir"),
    ]);
    expect(left.id).toBe(right.id);
    const child = await a.ensure(identity.id, "/å🚀_%/file", "file");
    const untouched = await a.ensure(identity.id, "/å🚀XX/other", "file");
    const isolated = await a.ensure(other.id, child.path, "file");
    expect(await b.children(identity.id, left.path)).toEqual([child]);
    expect((await b.children(identity.id, "/")).map((item) => item.id)).toEqual([left.id]);
    const provisional = await a.ensure(identity.id, "/renamed/file", "file");
    await expect(a.move(identity.id, left.path, `${left.path}/inside`)).rejects.toThrow("overlap");
    await expect(a.move(identity.id, left.path, "/")).rejects.toThrow("overlap");
    await a.move(identity.id, left.path, "/renamed");
    expect(await b.item(identity.id, provisional.id)).toBeNull();
    await b.move(identity.id, left.path, "/renamed");
    expect((await a.item(identity.id, child.id))?.path).toBe("/renamed/file");
    expect((await a.item(identity.id, untouched.id))?.path).toBe(untouched.path);
    expect((await a.item(other.id, isolated.id))?.path).toBe(isolated.path);
    expect(await a.item(other.id, child.id)).toBeNull();
    expect(await a.at(identity.id, left.path)).toBeNull();
    const updated = await b.update(identity.id, child.id, {
      contentVersion: "digest",
      originalPath: "/original",
    });
    expect(updated.contentVersion).toBe("digest");
    expect(updated.metadataVersion).not.toBe(child.metadataVersion);
    await a.move(identity.id, "/renamed", "/renamed");
    const replaced = await a.ensure(identity.id, "/renamed", "file");
    expect(replaced.id).not.toBe(left.id);
    expect(await b.item(identity.id, child.id)).toBeNull();
    await expect(a.update(identity.id, child.id, { contentVersion: "gone" })).rejects.toThrow(
      "no longer exists",
    );
    await a.remove(identity.id, "/renamed");
    expect(await b.at(identity.id, "/renamed")).toBeNull();
    const input = {
      id: randomUUID(),
      identityId: identity.id,
      accountId: account.id,
      requestHash: "hash",
      request: { size: 3 },
      state: "receiving",
    };
    const [one, two] = await Promise.all([a.reserve(input), b.reserve(input)]);
    expect(one).toEqual(two);
    const outcomes = await Promise.all([
      a.transition(identity.id, account.id, input.id, "receiving", "uploading", {
        attempt: "first",
      }),
      b.transition(identity.id, account.id, input.id, "receiving", "uploading", {
        attempt: "second",
      }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(
      await a.transition(identity.id, account.id, input.id, "uploading", "ready", {}, "stale"),
    ).toBe(false);
    const attempt = (await a.operation(identity.id, account.id, input.id))?.result
      ?.attempt as string;
    expect(
      await b.transition(
        identity.id,
        account.id,
        input.id,
        "uploading",
        "ready",
        { uploadFile: "file" },
        attempt,
      ),
    ).toBe(true);
    expect(await a.operation(other.id, account.id, input.id)).toBeNull();
    expect(await a.operation(identity.id, randomUUID(), input.id)).toBeNull();
    await expect(a.reserve({ ...input, accountId: randomUUID() })).rejects.toThrow(
      "another account",
    );
    await expect(
      a.reserve({ ...input, id: randomUUID(), request: { size: 65 * 1024 ** 3 } }),
    ).rejects.toThrow("capacity");
    await a.transition(identity.id, account.id, input.id, "ready", "completed", {
      receipt: "durable",
    });
    expect((await b.operation(identity.id, account.id, input.id))?.result).toEqual({
      receipt: "durable",
    });
    // Retention: only expired states qualify, reclaiming releases the reservation once.
    const retention = { idleMs: 1000, conflictMs: 2000, retainMs: 3000 };
    const now = new Date();
    const stale = new Date(now.getTime() - 5000);
    const seed = async (state: string, size: number, updatedAt = stale, recoveryBytes = 0) => {
      const op = { ...input, id: randomUUID(), state, request: { size, recoveryBytes } };
      await a.reserve(op);
      await first.db.execute(
        sql`update app.desktop_operations set updated_at = ${updatedAt.toISOString()}::timestamptz, state = ${state} where id = ${op.id}`,
      );
      return op.id;
    };
    const idle = await seed("uploading", 1);
    const fresh = await seed("receiving", 1, now);
    const conflict = await seed("conflict", 1);
    const acknowledged = await seed("acknowledged", 0, stale, 64 * 1024 ** 3 - 64);
    const uncertain = await seed("uncertain", 1);
    const committing = await seed("committing", 1);
    expect((await a.expired(now, retention, 10)).map((op) => op.id).sort()).toEqual(
      [idle, conflict, acknowledged].sort(),
    );
    expect((await b.uncertain(10)).map((op) => op.id).sort()).toEqual(
      [uncertain, committing].sort(),
    );
    expect(fresh).toBeTruthy();
    await expect(a.reserve({ ...input, id: randomUUID(), request: { size: 60 } })).rejects.toThrow(
      "capacity",
    );
    expect(await a.reclaim(identity.id, account.id, idle, now)).toBe(false);
    expect(await a.reclaim(identity.id, account.id, acknowledged, now)).toBe(true);
    expect(await b.reclaim(identity.id, account.id, acknowledged, now)).toBe(false);
    expect((await a.expired(now, retention, 10)).map((op) => op.id)).not.toContain(acknowledged);
    await a.reserve({ ...input, id: randomUUID(), request: { size: 60 } });
  } finally {
    await first.close();
    await second.close();
    await container.stop();
  }
});

it("registers many desktop paths at once, parents first, without the lock when all exist", {
  timeout: 180_000,
}, async () => {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const first = createDb(container.getConnectionUri());
  const second = createDb(container.getConnectionUri());
  try {
    await migrate(first.db);
    const repos = createRepos(first.db);
    const account = await repos.accounts.create({ displayName: "Desktop" });
    const provider = await repos.providers.ensure({
      type: "webdav",
      baseUrl: "http://desktop.test/dav",
    });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    const other = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "bob",
    });
    const a = createDesktopRepo(first.db),
      b = createDesktopRepo(second.db);
    expect(await a.ensureMany(identity.id, [])).toEqual([]);
    const listing = [
      { path: "/å🚀_%/b", kind: "file" },
      { path: "/å🚀_%/a", kind: "dir" },
      { path: "/å🚀_%", kind: "dir" },
      { path: "/å🚀_%", kind: "dir" },
    ];
    const [left, right] = await Promise.all([
      a.ensureMany(identity.id, listing),
      b.ensureMany(identity.id, [...listing].reverse()),
    ]);
    expect(left?.map((item) => item.path)).toEqual(listing.map((item) => item.path));
    expect(left?.[2]?.id).toBe(left?.[3]?.id);
    expect(new Set(right?.map((item) => item.id))).toEqual(new Set(left?.map((item) => item.id)));
    expect(await a.ensure(identity.id, "/å🚀_%/a", "dir")).toEqual(left?.[1]);
    // Lookups read live rows only and never register a path.
    expect(await b.lookup(identity.id, [])).toEqual([]);
    expect(await b.lookup(identity.id, ["/å🚀_%/a", "/å🚀_%/a", "/never"])).toEqual([left?.[1]]);
    expect(await b.at(identity.id, "/never")).toBeNull();
    expect(await b.lookup(other.id, ["/å🚀_%/a"])).toEqual([]);
    const isolated = await b.ensureMany(other.id, listing);
    expect(isolated.map((item) => item.id)).not.toContain(left?.[0]?.id);
    await expect(
      a.ensureMany(identity.id, [
        { path: "/x", kind: "file" },
        { path: "/x", kind: "dir" },
      ]),
    ).rejects.toThrow("Conflicting");

    // A fully registered listing reads without taking the identity lock.
    const locked = await second.pool.connect();
    try {
      await locked.query("begin");
      await locked.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify(["desktop-items", identity.id]),
      ]);
      expect((await a.ensureMany(identity.id, listing)).map((item) => item.id)).toEqual(
        left?.map((item) => item.id),
      );
    } finally {
      await locked.query("rollback");
      locked.release();
    }

    // A folder previously registered as a file retires its subtree before its children
    // are matched, so every returned row stays live.
    await a.ensure(identity.id, "/swap", "file");
    const swapped = await a.ensureMany(identity.id, [
      { path: "/swap/child", kind: "file" },
      { path: "/swap", kind: "dir" },
    ]);
    for (const item of swapped) expect(await b.item(identity.id, item.id)).toEqual(item);
    expect(swapped[0]?.path).toBe("/swap/child");
    const replaced = await a.ensureMany(identity.id, [
      { path: "/swap/child", kind: "dir" },
      { path: "/swap/other", kind: "file" },
    ]);
    expect(replaced[0]?.id).not.toBe(swapped[0]?.id);
    expect(await b.item(identity.id, swapped[0]?.id as string)).toBeNull();
    expect((await b.children(identity.id, "/swap")).map((item) => item.path).sort()).toEqual([
      "/swap/child",
      "/swap/other",
    ]);
    // Several replaced paths retire outermost first, whatever order they arrive in.
    const inner = await a.ensure(identity.id, "/deep/inner", "dir");
    const outer = await a.ensure(identity.id, "/deep", "file");
    const both = await a.ensureMany(identity.id, [
      { path: "/deep/inner", kind: "file" },
      { path: "/deep", kind: "dir" },
    ]);
    expect(both.map((item) => item.id)).not.toContain(inner.id);
    expect(both.map((item) => item.id)).not.toContain(outer.id);
    for (const item of both) expect(await b.item(identity.id, item.id)).toEqual(item);
  } finally {
    await first.close();
    await second.close();
    await container.stop();
  }
});
