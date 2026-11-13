import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CreateDbResult,
  createDb,
  createIdentityLinksRepo,
  createShareRepo,
  migrate,
  type ShareInsertInput,
  type ShareOwnedUpdate,
  type ShareRepo,
} from "../../src/index.js";
import { accounts, identities, providers, shares } from "../../src/schema/app.js";

const providerId = "00000000-0000-0000-0000-000000000001";
const accountId = "00000000-0000-0000-0000-000000000011";
const targetAccountId = "00000000-0000-0000-0000-000000000012";
const identityId = "00000000-0000-0000-0000-000000000021";
const otherIdentity = "00000000-0000-0000-0000-000000000022";
const at = new Date("2026-09-07T01:00:00Z");
const later = new Date(at.getTime() + 1000);
const input: ShareInsertInput = {
  identityId,
  name: "Shared",
  description: "",
  scope: "read",
  paths: ["/folder"],
  expiresAt: null,
  maxDownloads: 0,
  presentation: "auto",
  passwordHash: null,
  at,
};
const update: ShareOwnedUpdate = {
  name: "Shared",
  description: "",
  scope: "read",
  paths: ["/folder"],
  expiresAt: null,
  maxDownloads: 0,
  presentation: "auto",
  at: later,
};
let container: StartedPostgreSqlContainer | undefined;
let first: CreateDbResult;
let second: CreateDbResult;
const disconnected: Promise<void>[] = [];
type Sortable = { readonly id: string; readonly createdAt: Date };
function byNewestThenId(x: Sortable, y: Sortable): number {
  return y.createdAt.getTime() - x.createdAt.getTime() || x.id.localeCompare(y.id);
}
let a: ShareRepo;
let b: ShareRepo;
beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();
  first = createDb(container.getConnectionUri());
  second = createDb(container.getConnectionUri());
  for (const connection of [first, second]) {
    connection.pool.on("connect", (client) => {
      disconnected.push(new Promise<void>((resolve) => client.once("end", resolve)));
    });
  }
  await migrate(first.db);
  await first.db.insert(providers).values({ id: providerId, type: "local", baseUrl: "local" });
  a = createShareRepo(first.db);
  b = createShareRepo(second.db);
});
afterAll(async () => {
  const results = await Promise.allSettled([first?.close(), second?.close()]);
  // pg-pool resolves end() before idle clients finish closing their sockets.
  await Promise.all(disconnected);
  await container?.stop();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});
beforeEach(async () => {
  await first.db.execute(sql`truncate app.accounts cascade`);
  await first.db.insert(accounts).values([{ id: accountId }, { id: targetAccountId }]);
  await first.db.insert(identities).values([
    { id: identityId, accountId, providerId, externalUsername: "alice" },
    { id: otherIdentity, accountId: targetAccountId, providerId, externalUsername: "bob" },
  ]);
});

describe("PostgreSQL shares", () => {
  it("inserts a row and replaces its fields, keeping its UUID and creation time", async () => {
    const original = await a.insert(input);
    expect(original).toMatchObject({
      identityId,
      createdAt: at,
      updatedAt: at,
      paths: ["/folder"],
      hasPassword: false,
      views: 0,
    });
    const updated = await b.updateOwned(identityId, original.id, {
      ...update,
      name: "Updated",
      description: "With notes",
      scope: "write",
      paths: ["/upload", "/other"],
      expiresAt: later,
      maxDownloads: 5,
      presentation: "gallery",
      passwordHash: "hash-1",
    });
    expect(updated).toEqual({
      ...original,
      name: "Updated",
      description: "With notes",
      scope: "write",
      paths: ["/upload", "/other"],
      hasPassword: true,
      expiresAt: later,
      maxDownloads: 5,
      presentation: "gallery",
      updatedAt: later,
    });
    expect(await a.get(original.id)).toEqual(updated);
    expect(await a.getOwned(identityId, original.id)).toEqual(updated);
    expect(await first.db.select().from(shares)).toHaveLength(1);
  });

  it("keeps one row under simultaneous updates from independent pools", async () => {
    const row = await a.insert(input);
    const records = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        (i % 2 ? a : b).updateOwned(identityId, row.id, { ...update, name: `value-${i}` }),
      ),
    );
    expect(new Set(records.map((record) => record?.id))).toEqual(new Set([row.id]));
    expect(await first.db.select().from(shares)).toHaveLength(1);
    const current = await a.get(row.id);
    expect(records.map((record) => record?.name)).toContain(current?.name);
    expect(current?.createdAt).toEqual(at);
  });

  it("isolates ownership", async () => {
    const one = await a.insert(input);
    const two = await a.insert({ ...input, identityId: otherIdentity });
    expect(two.id).not.toBe(one.id);
    expect(await a.getOwned(otherIdentity, one.id)).toBeNull();
    expect(await a.getOwned(identityId, accountId)).toBeNull();
    expect(await a.listOwned(identityId)).toEqual([one]);
    expect(await a.updateOwned(otherIdentity, one.id, update)).toBeNull();
    expect(await a.removeOwned(otherIdentity, one.id)).toBe(false);
    expect(await a.get(one.id)).toEqual(one);
    expect(await a.removeOwned(identityId, one.id)).toBe(true);
    expect(await a.removeOwned(identityId, one.id)).toBe(false);
    expect(await a.get(one.id)).toBeNull();
    expect(await a.get(two.id)).toEqual(two);
    expect(await first.db.select().from(identities)).toHaveLength(2);
  });

  it("bounds lists and sorts by newest timestamp then UUID", async () => {
    await first.db.execute(sql`
      insert into app.shares(identity_id, name, scope, paths, created_at)
      select ${identityId}::uuid, 'bulk-' || n, 'read', array['/'], ${at}::timestamptz
      from generate_series(1,1200) as n
    `);
    const newest = await a.insert({ ...input, name: "newest", at: later });
    const tied = await a.insert({ ...input, name: "tied", at: later });
    await a.insert({ ...input, identityId: otherIdentity, at: new Date(later.getTime() + 1000) });
    expect(await a.listOwned(identityId, { limit: 2 })).toEqual(
      [newest, tied].sort(byNewestThenId),
    );
    const defaultList = await a.listOwned(identityId);
    expect(defaultList).toHaveLength(200);
    expect(await a.listOwned(identityId, {})).toEqual(defaultList);
    expect(await a.listOwned(identityId, { limit: 1000 })).toHaveLength(1000);
    expect(await a.listOwned(accountId)).toEqual([]);
  });

  it("keeps the same share when its identity transfers to another account", async () => {
    const share = await a.insert(input);
    await createIdentityLinksRepo(first.db).linkVerified({
      accountId: targetAccountId,
      providerId,
      username: "alice",
      at,
      sealCredential: () => ({ ciphertext: new Uint8Array([1]), keyId: "test" }),
    });
    const [identity] = await first.db
      .select()
      .from(identities)
      .where(eq(identities.id, identityId));
    expect(identity?.accountId).toBe(targetAccountId);
    expect(await a.get(share.id)).toEqual(share);
    expect(await a.getOwned(identityId, share.id)).toEqual(share);
    expect(await a.getOwned(otherIdentity, share.id)).toBeNull();
  });

  it("stores the password only as a hash no record carries, and no extra runtime properties", async () => {
    const share = await a.insert({
      ...input,
      password: "do-not-store",
      upstreamToken: "do-not-store",
    } as ShareInsertInput);
    expect(share).not.toHaveProperty("password");
    expect(share).not.toHaveProperty("upstreamToken");
    const columns = await first.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_schema='app' and table_name='shares' order by column_name`,
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      "created_at",
      "description",
      "expires_at",
      "has_password",
      "id",
      "identity_id",
      "max_downloads",
      "name",
      "password_hash",
      "paths",
      "presentation",
      "scope",
      "updated_at",
      "views",
    ]);
    // The one secret-bearing column is read by one method and never rides on a record.
    const locked = await a.insert({ ...input, passwordHash: "hash-1" });
    expect(locked).toMatchObject({ hasPassword: true });
    expect(locked).not.toHaveProperty("passwordHash");
    expect(await a.get(locked.id)).not.toHaveProperty("passwordHash");
    expect(await a.getOwned(identityId, locked.id)).not.toHaveProperty("passwordHash");
    expect((await a.listOwned(identityId))[0]).not.toHaveProperty("passwordHash");
    expect(await a.passwordHash(locked.id)).toBe("hash-1");
    expect(await a.passwordHash(share.id)).toBeNull();
  });

  it("keeps, replaces and removes a password on update", async () => {
    const open = await a.insert(input);
    const locked = await b.insert({ ...input, name: "Locked", passwordHash: "hash-1", at: later });
    expect(await a.listOwned(identityId)).toEqual([locked, open].sort(byNewestThenId));
    const renamed = await b.updateOwned(identityId, locked.id, {
      ...update,
      name: "Renamed",
      maxDownloads: 3,
      at: new Date(later.getTime() + 1000),
    });
    expect(renamed).toEqual({
      ...locked,
      name: "Renamed",
      maxDownloads: 3,
      updatedAt: new Date(later.getTime() + 1000),
    });
    expect(await a.passwordHash(locked.id)).toBe("hash-1");
    expect(
      (await a.updateOwned(identityId, locked.id, { ...update, passwordHash: "hash-2" }))
        ?.hasPassword,
    ).toBe(true);
    expect(await a.passwordHash(locked.id)).toBe("hash-2");
    expect(
      (await a.updateOwned(identityId, locked.id, { ...update, passwordHash: null }))?.hasPassword,
    ).toBe(false);
    expect(await a.passwordHash(locked.id)).toBeNull();
    expect(await a.removeOwned(identityId, locked.id)).toBe(true);
    expect(await a.passwordHash(locked.id)).toBeNull();
  });

  it("consumes downloads concurrently up to the limit and never past expiry", async () => {
    const limited = await a.insert({ ...input, maxDownloads: 10 });
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).consume(limited.id, at)),
    );
    expect(outcomes.filter((row) => row !== null)).toHaveLength(10);
    expect((await a.get(limited.id))?.views).toBe(10);
    expect(await a.consume(limited.id, at)).toBeNull();
    const unlimited = await a.insert(input);
    expect((await a.consume(unlimited.id, at))?.views).toBe(1);
    const expiring = await a.insert({ ...input, expiresAt: later });
    expect((await a.consume(expiring.id, at))?.views).toBe(1);
    expect(await a.consume(expiring.id, later)).toBeNull();
    expect(await a.consume("00000000-0000-4000-8000-000000000099", at)).toBeNull();
  });

  it("refuses a password flag the stored hash contradicts", async () => {
    for (const [hasPassword, hash] of [
      [true, null],
      [false, "hash"],
    ] as const)
      await expect(
        first.db.execute(sql`
          insert into app.shares(identity_id, name, scope, paths, has_password, password_hash)
          values (${identityId}::uuid, 'x', 'read', array['/'], ${hasPassword}, ${hash})
        `),
      ).rejects.toMatchObject({ cause: { constraint: "shares_password_hash_kind" } });
    expect(await first.db.select().from(shares)).toHaveLength(0);
  });

  it("rejects invalid input atomically and validates every method before IO", async () => {
    const share = await a.insert(input);
    await expect(
      a.updateOwned(identityId, share.id, { ...update, maxDownloads: -1 }),
    ).rejects.toThrow(TypeError);
    expect(await a.get(share.id)).toEqual(share);
    const closed = createDb("postgresql://unused:unused@127.0.0.1:1/unused");
    await closed.close();
    const repo = createShareRepo(closed.db);
    await expect(repo.insert({ ...input, paths: [] })).rejects.toThrow(TypeError);
    await expect(repo.insert({ ...input, passwordHash: "" })).rejects.toThrow(TypeError);
    await expect(repo.updateOwned(identityId, "bad", update)).rejects.toThrow(TypeError);
    await expect(repo.passwordHash("bad")).rejects.toThrow(TypeError);
    await expect(repo.consume("bad", at)).rejects.toThrow(TypeError);
    await expect(repo.get("bad")).rejects.toThrow(TypeError);
    await expect(repo.getOwned(identityId, "bad")).rejects.toThrow(TypeError);
    await expect(repo.listOwned(identityId, { limit: 0 })).rejects.toThrow(TypeError);
    await expect(repo.removeOwned("bad", identityId)).rejects.toThrow(TypeError);
  });
});
