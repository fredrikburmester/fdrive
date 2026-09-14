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
