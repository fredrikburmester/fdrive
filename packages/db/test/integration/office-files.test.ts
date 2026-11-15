import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CreateDbResult,
  createDb,
  createOfficeFileRepo,
  migrate,
  type OfficeFileRepo,
} from "../../src/index.js";
import { accounts, identities, officeFiles, providers } from "../../src/schema/app.js";
import { files as indexedFiles, roots } from "../../src/schema/idx.js";

let container: StartedPostgreSqlContainer | undefined;
let first: CreateDbResult;
let second: CreateDbResult;
let a: OfficeFileRepo;
let b: OfficeFileRepo;
const owner = "00000000-0000-0000-0000-000000000001";
const other = "00000000-0000-0000-0000-000000000002";
const location = { identityId: owner, path: "/folder/file.docx" };
const at = new Date("2026-09-06T12:00:00Z");
const move = {
  from: { identityId: owner, path: "/folder" },
  to: { identityId: owner, path: "/moved" },
  at,
};
const loc = (identityId: string, path: string) => ({ identityId, path });
beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();
  first = createDb(container.getConnectionUri());
  second = createDb(container.getConnectionUri());
  await migrate(first.db);
  const [provider] = await first.db
    .insert(providers)
    .values({ type: "local", baseUrl: "local" })
    .returning();
  if (!provider) throw new Error("Missing provider");
  for (const [id, username] of [
    [owner, "alice"],
    [other, "bob"],
  ] as const) {
    const [account] = await first.db.insert(accounts).values({ displayName: username }).returning();
    if (!account) throw new Error("Missing account");
    await first.db
      .insert(identities)
      .values({ id, accountId: account.id, providerId: provider.id, externalUsername: username });
  }
  a = createOfficeFileRepo(first.db);
  b = createOfficeFileRepo(second.db);
});
afterAll(async () => {
  await Promise.allSettled([first?.close(), second?.close()]);
  await container?.stop();
});
beforeEach(async () => {
  await first.db.execute(sql`truncate app.office_files`);
});

describe("Postgres office registry", () => {
  it("serializes concurrent opens across independent pools and users", async () => {
    for (let i = 0; i < 15; i++) {
      const target = { ...location, path: `/file-${i}.docx` };
      const [left, right] = await Promise.all([a.ensure(target), b.ensure(target)]);
      expect(left).toEqual(right);
    }
    expect(await first.db.select().from(officeFiles)).toHaveLength(15);
  });
  it("preserves UUID on exact and subtree moves, isolates owners and replaces destination", async () => {
    const source = await a.ensure(location);
    const child = await a.ensure({ ...location, path: "/folder/sub/child" });
    const replaced = await a.ensure({ ...location, path: "/moved/file.docx" });
    const untouched = await Promise.all([
      a.ensure({ ...location, path: "/folder-sibling/file.docx" }),
      a.ensure({ ...location, identityId: other }),
      a.ensure(loc(other, "/moved/file.docx")),
      a.ensure({ ...location, path: "/moved/unrelated.docx" }),
    ]);
    await a.movePrefix(move);
    await b.movePrefix(move);
    expect(await a.get(source.id)).toEqual({ ...source, path: "/moved/file.docx" });
    expect(await b.get(child.id)).toEqual({ ...child, path: "/moved/sub/child" });
    expect(await a.get(replaced.id)).toBeNull();
    const [deleted] = await first.db
      .select()
      .from(officeFiles)
      .where(eq(officeFiles.id, replaced.id));
    expect(deleted?.deletedAt).toEqual(at);
    for (const file of untouched) expect(await a.get(file.id)).toEqual(file);
    const renamed = loc(owner, "/renamed.docx");
    await a.movePrefix({ from: loc(owner, "/moved/file.docx"), to: renamed, at });
    await a.movePrefix({ from: renamed, to: renamed, at });
    expect(await a.get(source.id)).toEqual({ ...source, path: "/renamed.docx" });
  });
  it("follows a move into another owner's files and replaces what was there", async () => {
    const file = await a.ensure(location);
    const child = await a.ensure({ ...location, path: "/folder/sub/child" });
    const replaced = await a.ensure(loc(other, "/shared/folder/file.docx"));
    const kept = await a.ensure(loc(other, "/shared/folder/kept.docx"));
    await a.movePrefix({ from: move.from, to: loc(other, "/shared/folder"), at });
    expect(await b.get(file.id)).toEqual({ ...file, ...loc(other, "/shared/folder/file.docx") });
    expect(await b.get(child.id)).toEqual({ ...child, ...loc(other, "/shared/folder/sub/child") });
    expect(await b.get(replaced.id)).toBeNull();
    expect(await b.get(kept.id)).toEqual(kept);
    expect((await b.ensure(location)).id).not.toBe(file.id);
  });
  it("escapes wildcard, slash and quote names and counts Unicode SQL characters correctly", async () => {
    const from = "/📁_%\\'";
    const file = await a.ensure({ ...location, path: `${from}/file` });
    const sibling = await a.ensure({ ...location, path: "/📁wildcard/file" });
    await a.movePrefix({ from: loc(owner, from), to: loc(owner, "/new'_%\\📁"), at });
    expect((await a.get(file.id))?.path).toBe("/new'_%\\📁/file");
    await a.deletePrefix({ ...location, path: "/new'_%\\📁", at });
    expect(await a.get(file.id)).toBeNull();
    expect(await a.get(sibling.id)).toEqual(sibling);
  });
  it("tombstones exact and prefix deletions and recreates a fresh UUID", async () => {
    const file = await a.ensure(location);
    const sibling = await a.ensure({ ...location, path: "/folder2/file" });
    const others = await a.ensure({ ...location, identityId: other });
    await a.deletePrefix({ ...location, path: "/folder", at });
    await b.deletePrefix({ ...location, path: "/folder", at });
    expect(await a.get(file.id)).toBeNull();
    expect(await a.get(sibling.id)).toEqual(sibling);
    const recreated = await b.ensure(location);
    expect(recreated.id).not.toBe(file.id);
    await a.deletePrefix({ ...location, at });
    expect(await a.get(recreated.id)).toBeNull();
    expect(await a.get(others.id)).toEqual(others);
  });
  it("goes with its owner's login", async () => {
    const file = await a.ensure(loc(other, "/gone.docx"));
    const kept = await a.ensure(location);
    await first.db.delete(identities).where(eq(identities.id, other));
    expect(await a.get(file.id)).toBeNull();
    expect(await a.get(kept.id)).toEqual(kept);
    const [account] = await first.db.insert(accounts).values({ displayName: "bob" }).returning();
    const [provider] = await first.db.select().from(providers);
    if (!account || !provider) throw new Error("Missing rows");
    await first.db.insert(identities).values({
      id: other,
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "bob",
    });
  });
  it("rolls back replacement tombstones if the subsequent path update fails", async () => {
    const source = await a.ensure(location);
    const destination = await a.ensure({ ...location, path: "/moved/file.docx" });
    await first.db.execute(
      sql`alter table app.office_files add constraint simulated_failure check (deleted_at is not null or path <> '/moved/file.docx') not valid`,
    );
    try {
      await expect(a.movePrefix(move)).rejects.toThrow();
      expect(await b.get(source.id)).toEqual(source);
      expect(await b.get(destination.id)).toEqual(destination);
    } finally {
      await first.db.execute(sql`alter table app.office_files drop constraint simulated_failure`);
    }
    await b.movePrefix(move);
    expect(await a.get(destination.id)).toBeNull();
  });
  it("does not couple office identity to index rows or index clears", async () => {
    await first.db.insert(roots).values({ name: "root" }).onConflictDoNothing();
    const [root] = await first.db.select().from(roots).where(eq(roots.name, "root"));
    if (!root) throw new Error("Missing root");
    await first.db
      .insert(indexedFiles)
      .values({ rootId: root.id, path: location.path, name: "file.docx", size: 1, mtimeNs: 1n });
    const file = await a.ensure(location);
    await first.db.delete(indexedFiles);
    expect(await b.ensure(location)).toEqual(file);
    expect(await b.get(file.id)).toEqual(file);
  });
  it("moves more than PostgreSQL's parameter limit without materializing registry rows", async () => {
    await first.db.execute(sql`
      insert into app.office_files (identity_id, path)
      select ${owner}, '/folder/file-' || n || '.docx'
      from generate_series(1, 66000) as n
    `);
    const conflicts = await Promise.all([
      a.ensure({ ...location, path: "/moved/file-1.docx" }),
      a.ensure({ ...location, path: "/moved/file-66000.docx" }),
    ]);
    const unrelated = await a.ensure({ ...location, path: "/moved/unrelated.docx" });
    const before = await first.db.execute<{ count: number; identity: string }>(sql`
      select count(*)::integer as count,
        md5(string_agg(id::text || created_at::text, ',' order by id)) as identity
      from app.office_files where path like '/folder/%' and deleted_at is null
    `);
    await a.movePrefix(move);
    await b.movePrefix(move);
    const after = await first.db.execute<{ count: number; identity: string }>(sql`
      select count(*)::integer as count,
        md5(string_agg(id::text || created_at::text, ',' order by id)) as identity
      from app.office_files where path like '/moved/file-%' and deleted_at is null
    `);
    expect(before.rows[0]?.count).toBe(66000);
    expect(after.rows).toEqual(before.rows);
    for (const conflict of conflicts) expect(await a.get(conflict.id)).toBeNull();
    expect(await a.get(unrelated.id)).toEqual(unrelated);
    const remaining = await first.db.execute<{ count: number }>(sql`
      select count(*)::integer as count from app.office_files where path like '/folder/%'
    `);
    expect(remaining.rows[0]?.count).toBe(0);
  });
  it("validates before database access and rejects overlapping renames", async () => {
    const closed = createDb("postgresql://unused:unused@127.0.0.1:1/unused");
    await closed.close();
    const repo = createOfficeFileRepo(closed.db);
    await expect(repo.ensure({ ...location, path: "/../bad" })).rejects.toThrow(TypeError);
    await expect(repo.get("bad")).rejects.toThrow(TypeError);
    await expect(repo.deletePrefix({ ...location, path: "bad", at })).rejects.toThrow(TypeError);
    await expect(repo.deletePrefix({ ...location, path: "/", at })).rejects.toThrow(TypeError);
    await expect(repo.movePrefix({ ...move, to: loc(owner, "/folder/sub") })).rejects.toThrow(
      TypeError,
    );
    await expect(
      repo.movePrefix({ ...move, from: loc(owner, "/folder/sub"), to: loc(owner, "/folder") }),
    ).rejects.toThrow(TypeError);
    await expect(repo.movePrefix({ ...move, to: move.from })).resolves.toBeUndefined();
  });
});
