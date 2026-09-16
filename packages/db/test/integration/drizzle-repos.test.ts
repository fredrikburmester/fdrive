import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, createOfficeFileRepo, type Db, migrate } from "../../src/index.js";
import { createRepos } from "../../src/repos/drizzle.js";
import { PATH_CHUNK_SIZE } from "../../src/repos/path-chunks.js";
import { favorites, fileTags, folderViews, recents } from "../../src/schema/app.js";
import { defineReposSuite } from "../repos-suite.js";

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let close: () => Promise<void>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();

  const created = createDb(container.getConnectionUri());
  db = created.db;
  pool = created.pool;
  close = created.close;
  await migrate(db);
}, 180_000);

afterAll(async () => {
  await close();
  await container.stop();
}, 180_000);

defineReposSuite("drizzle", async () => {
  await db.execute(sql`
    truncate table
      app.sessions,
      app.api_tokens,
      app.credentials,
      app.file_tags,
      app.favorites,
      app.folder_views,
      app.recents,
      app.tags,
      app.identities,
      app.accounts,
      app.providers,
      app.settings,
      app.system_events
    cascade
  `);
  return createRepos(db);
});

const wildcardPrefixes = [
  { label: "percent", source: "/literal%folder", sibling: "/literalXfolder" },
  { label: "underscore", source: "/literal_folder", sibling: "/literalXfolder" },
  { label: "backslash", source: String.raw`/literal\folder`, sibling: "/literalfolder" },
] as const;

async function seedMetadataPaths(identityId: string, accountId: string, paths: readonly string[]) {
  const repos = createRepos(db);
  const tag = await repos.tags.create(accountId, { name: "prefix-test", color: null });
  for (const path of paths) {
    await Promise.all([
      repos.fileTags.setTags(identityId, path, [tag.id]),
      repos.favorites.add(identityId, path, "file"),
      repos.folderViews.set(identityId, path, { mode: "list" }),
      repos.recents.touch(identityId, path),
    ]);
  }
}

async function metadataPaths(identityId: string): Promise<Record<string, string[]>> {
  const rows = await Promise.all([
    db.select({ path: fileTags.path }).from(fileTags).where(eq(fileTags.identityId, identityId)),
    db.select({ path: favorites.path }).from(favorites).where(eq(favorites.identityId, identityId)),
    db
      .select({ path: folderViews.path })
      .from(folderViews)
      .where(eq(folderViews.identityId, identityId)),
    db.select({ path: recents.path }).from(recents).where(eq(recents.identityId, identityId)),
  ]);
  return Object.fromEntries(
    ["fileTags", "favorites", "folderViews", "recents"].map((name, index) => [
      name,
      (rows[index] ?? []).map((row) => row.path).sort(),
    ]),
  );
}

async function waitForLockWaiters(count = 1): Promise<void> {
  await expect
    .poll(
      async () => {
        const rows = await db.execute<{ count: number }>(sql`
          select count(*)::int as count
          from pg_locks
          where not granted
        `);
        return rows.rows[0]?.count;
      },
      { timeout: 2_000 },
    )
    .toBeGreaterThanOrEqual(count);
}

describe("metadata prefix operations", () => {
  beforeEach(async () => {
    await db.execute(sql`
      truncate table
        app.file_tags,
        app.favorites,
        app.folder_views,
        app.recents,
        app.tags,
        app.identities,
        app.accounts,
        app.providers
      cascade
    `);
  });

  async function createIdentity(label: string) {
    const repos = createRepos(db);
    const provider = await repos.providers.ensure({
      type: "sftpgo",
      baseUrl: `http://prefix-${label}`,
    });
    const account = await repos.accounts.create({ displayName: label });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: label,
    });
    return { account, identity, repos };
  }

  it.each(wildcardPrefixes)(
    "moves a $label path prefix literally across every metadata repository",
    async ({ label, source, sibling }) => {
      const { account, identity, repos } = await createIdentity(`move-${label}`);
      const target = `/moved-${label}`;
      await seedMetadataPaths(identity.id, account.id, [
        source,
        `${source}/child`,
        sibling,
        `${sibling}/child`,
      ]);

      await repos.metadataPaths.movePrefix(identity.id, source, target, true);

      const expected = [target, `${target}/child`, sibling, `${sibling}/child`].sort();
      expect(await metadataPaths(identity.id)).toEqual({
        fileTags: expected,
        favorites: expected,
        folderViews: expected,
        recents: expected,
      });
    },
  );

  it("moves Unicode descendants and replaces destination conflicts across every metadata repository", async () => {
    const { account, identity, repos } = await createIdentity("move-unicode");
    const source = "/archive-📁";
    const target = "/moved";
    const sourceChild = `${source}/child.txt`;
    const targetChild = `${target}/child.txt`;
    const sourceOpenedAt = new Date("2026-01-01T00:00:00.000Z");
    const destinationOpenedAt = new Date("2026-02-01T00:00:00.000Z");
    const sourceTag = await repos.tags.create(account.id, { name: "source", color: null });
    const destinationTag = await repos.tags.create(account.id, {
      name: "destination",
      color: null,
    });

    await repos.fileTags.setTags(identity.id, sourceChild, [sourceTag.id]);
    await repos.fileTags.setTags(identity.id, targetChild, [destinationTag.id]);
    await repos.favorites.add(identity.id, sourceChild, "file");
    await repos.favorites.add(identity.id, targetChild, "dir");
    await repos.folderViews.set(identity.id, sourceChild, { mode: "grid" });
    await repos.folderViews.set(identity.id, targetChild, { mode: "list" });
    await repos.recents.touch(identity.id, sourceChild);
    await repos.recents.touch(identity.id, targetChild);
    await db
      .update(recents)
      .set({ openedAt: sourceOpenedAt })
      .where(and(eq(recents.identityId, identity.id), eq(recents.path, sourceChild)));
    await db
      .update(recents)
      .set({ openedAt: destinationOpenedAt })
      .where(and(eq(recents.identityId, identity.id), eq(recents.path, targetChild)));

    await repos.metadataPaths.movePrefix(identity.id, source, target, true);

    expect(await metadataPaths(identity.id)).toEqual({
      fileTags: [targetChild],
      favorites: [targetChild],
      folderViews: [targetChild],
      recents: [targetChild],
    });
    expect(
      (await repos.fileTags.tagsForPaths(identity.id, [targetChild])).get(targetChild),
    ).toEqual([sourceTag.id]);
    expect(await repos.favorites.list(identity.id)).toEqual([
      expect.objectContaining({ path: targetChild, kind: "file" }),
    ]);
    expect(await repos.folderViews.get(identity.id, targetChild)).toMatchObject({ mode: "grid" });
    expect(await repos.recents.list(identity.id, 10)).toEqual([
      expect.objectContaining({ path: targetChild, openedAt: sourceOpenedAt }),
    ]);
  });

  it("lets source metadata win when a destination insert is still uncommitted", async () => {
    const { account, identity, repos } = await createIdentity("move-race");
    const sourceTag = await repos.tags.create(account.id, { name: "source-race", color: null });
    const destinationTag = await repos.tags.create(account.id, {
      name: "destination-race",
      color: null,
    });
    const sourceOpenedAt = new Date("2026-01-01T00:00:00.000Z");
    const destinationOpenedAt = new Date("2026-02-01T00:00:00.000Z");

    const cases: Array<{
      label: string;
      seedSource: (path: string) => Promise<void>;
      insertDestination: (client: PoolClient, path: string) => Promise<unknown>;
      move: (source: string, destination: string) => Promise<void>;
      expectSourceAt: (path: string) => Promise<void>;
    }> = [
      {
        label: "file-tags",
        seedSource: (path) => repos.fileTags.setTags(identity.id, path, [sourceTag.id]),
        insertDestination: (client, path) =>
          client.query(
            `insert into app.file_tags (identity_id, path, tag_id) values ($1, $2, $3), ($1, $2, $4)`,
            [identity.id, path, sourceTag.id, destinationTag.id],
          ),
        move: (source, destination) =>
          repos.fileTags.movePrefix(identity.id, source, destination, false),
        expectSourceAt: async (path) => {
          expect((await repos.fileTags.tagsForPaths(identity.id, [path])).get(path)).toEqual([
            sourceTag.id,
          ]);
        },
      },
      {
        label: "favorites",
        seedSource: (path) => repos.favorites.add(identity.id, path, "file"),
        insertDestination: (client, path) =>
          client.query(
            `insert into app.favorites (identity_id, path, kind) values ($1, $2, 'dir')`,
            [identity.id, path],
          ),
        move: (source, destination) =>
          repos.favorites.movePrefix(identity.id, source, destination, false),
        expectSourceAt: async (path) => {
          expect(await repos.favorites.list(identity.id)).toContainEqual(
            expect.objectContaining({ path, kind: "file" }),
          );
        },
      },
      {
        label: "folder-views",
        seedSource: (path) => repos.folderViews.set(identity.id, path, { mode: "grid" }),
        insertDestination: (client, path) =>
          client.query(
            `insert into app.folder_views (identity_id, path, mode) values ($1, $2, 'list')`,
            [identity.id, path],
          ),
        move: (source, destination) =>
          repos.folderViews.movePrefix(identity.id, source, destination, false),
        expectSourceAt: async (path) => {
          expect(await repos.folderViews.get(identity.id, path)).toMatchObject({ mode: "grid" });
        },
      },
      {
        label: "recents",
        seedSource: async (path) => {
          await repos.recents.touch(identity.id, path);
          await db
            .update(recents)
            .set({ openedAt: sourceOpenedAt })
            .where(and(eq(recents.identityId, identity.id), eq(recents.path, path)));
        },
        insertDestination: (client, path) =>
          client.query(
            `insert into app.recents (identity_id, path, opened_at) values ($1, $2, $3)`,
            [identity.id, path, destinationOpenedAt],
          ),
        move: (source, destination) =>
          repos.recents.movePrefix(identity.id, source, destination, false),
        expectSourceAt: async (path) => {
          expect(await repos.recents.list(identity.id, 20)).toContainEqual(
            expect.objectContaining({ path, openedAt: sourceOpenedAt }),
          );
        },
      },
    ];

    for (const race of cases) {
      const source = `/race-source-${race.label}`;
      const destination = `/race-destination-${race.label}`;
      await race.seedSource(source);
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query("begin");
        await race.insertDestination(client, destination);
        const moveResult = race.move(source, destination).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await waitForLockWaiters();
        await client.query("commit");
        committed = true;
        const result = await moveResult;
        if (!result.ok) throw result.error;
      } finally {
        if (!committed) await client.query("rollback");
        client.release();
      }
      await race.expectSourceAt(destination);
    }
  });

  it("avoids a lock inversion with an existing destination tag update", async () => {
    const { account, identity, repos } = await createIdentity("move-tag-deadlock");
    const source = "/deadlock-source";
    const destination = "/deadlock-destination";
    const sourceTag = await repos.tags.create(account.id, { name: "deadlock-source", color: null });
    const oldDestinationTag = await repos.tags.create(account.id, {
      name: "deadlock-old-destination",
      color: null,
    });
    const newDestinationTag = await repos.tags.create(account.id, {
      name: "deadlock-new-destination",
      color: null,
    });
    await repos.fileTags.setTags(identity.id, source, [sourceTag.id]);
    await repos.fileTags.setTags(identity.id, destination, [oldDestinationTag.id]);

    await db.execute(sql`
      create function "app"."test_pause_file_tag_delete"() returns trigger
      language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(94004);
        return old;
      end
      $$
    `);
    await db.execute(sql`
      create trigger "test_pause_file_tag_delete"
      after delete on "app"."file_tags"
      for each row execute function "app"."test_pause_file_tag_delete"()
    `);

    const blocker = await pool.connect();
    let unlocked = false;
    let setResult: Promise<{ ok: true } | { ok: false; error: unknown }> | null = null;
    let moveResult: Promise<{ ok: true } | { ok: false; error: unknown }> | null = null;
    try {
      await blocker.query("select pg_advisory_lock(94004)");
      setResult = repos.fileTags.setTags(identity.id, destination, [newDestinationTag.id]).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForLockWaiters();

      moveResult = repos.fileTags.movePrefix(identity.id, source, destination, false).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForLockWaiters(2);
      await blocker.query("select pg_advisory_unlock(94004)");
      unlocked = true;

      for (const result of await Promise.all([setResult, moveResult])) {
        if (!result.ok) throw result.error;
      }
    } finally {
      if (!unlocked) await blocker.query("select pg_advisory_unlock(94004)");
      blocker.release();
      if (setResult && moveResult) await Promise.allSettled([setResult, moveResult]);
      await db.execute(sql`
        drop trigger if exists "test_pause_file_tag_delete" on "app"."file_tags"
      `);
      await db.execute(sql`drop function if exists "app"."test_pause_file_tag_delete"()`);
    }

    expect(
      (await repos.fileTags.tagsForPaths(identity.id, [destination])).get(destination),
    ).toEqual([sourceTag.id]);
    expect((await repos.fileTags.tagsForPaths(identity.id, [source])).has(source)).toBe(false);
  });

  it("treats a same-path metadata move as a no-op", async () => {
    const { account, identity, repos } = await createIdentity("move-same-path");
    const path = "/same";
    const tag = await repos.tags.create(account.id, { name: "same-path", color: null });
    const pinnedAt = new Date("2026-01-01T00:00:00.000Z");
    await repos.fileTags.setTags(identity.id, path, [tag.id]);
    await repos.favorites.add(identity.id, path, "file");
    await repos.folderViews.set(identity.id, path, { mode: "grid" });
    await repos.recents.touch(identity.id, path);
    await db
      .update(folderViews)
      .set({ updatedAt: pinnedAt })
      .where(and(eq(folderViews.identityId, identity.id), eq(folderViews.path, path)));

    await repos.metadataPaths.movePrefix(identity.id, path, path, true);

    expect(await metadataPaths(identity.id)).toEqual({
      fileTags: [path],
      favorites: [path],
      folderViews: [path],
      recents: [path],
    });
    expect(await repos.folderViews.get(identity.id, path)).toMatchObject({ updatedAt: pinnedAt });
  });

  it.each(wildcardPrefixes)(
    "deletes a $label path prefix literally across every metadata repository",
    async ({ label, source, sibling }) => {
      const { account, identity, repos } = await createIdentity(`delete-${label}`);
      await seedMetadataPaths(identity.id, account.id, [
        source,
        `${source}/child`,
        sibling,
        `${sibling}/child`,
      ]);

      await repos.metadataPaths.deletePrefix(identity.id, source, true);

      const expected = [sibling, `${sibling}/child`].sort();
      expect(await metadataPaths(identity.id)).toEqual({
        fileTags: expected,
        favorites: expected,
        folderViews: expected,
        recents: expected,
      });
    },
  );

  it("rolls back every metadata table when the final table fails", async () => {
    const { account, identity, repos } = await createIdentity("atomic-rollback");
    const source = "/source";
    await seedMetadataPaths(identity.id, account.id, [source]);
    await db.execute(sql`
      create function "app"."test_fail_metadata_path"() returns trigger
      language plpgsql as $$
      begin
        raise exception 'forced metadata failure';
      end
      $$
    `);
    await db.execute(sql`
      create trigger "test_fail_metadata_path_update"
      before update on "app"."recents"
      for each row execute function "app"."test_fail_metadata_path"()
    `);
    await db.execute(sql`
      create trigger "test_fail_metadata_path_delete"
      before delete on "app"."recents"
      for each row execute function "app"."test_fail_metadata_path"()
    `);

    try {
      await expect(
        repos.metadataPaths.movePrefix(identity.id, source, "/target", false),
      ).rejects.toThrow();
      expect(await metadataPaths(identity.id)).toEqual({
        fileTags: [source],
        favorites: [source],
        folderViews: [source],
        recents: [source],
      });

      await expect(repos.metadataPaths.deletePrefix(identity.id, source, false)).rejects.toThrow();
      expect(await metadataPaths(identity.id)).toEqual({
        fileTags: [source],
        favorites: [source],
        folderViews: [source],
        recents: [source],
      });
    } finally {
      await db.execute(sql`
        drop trigger if exists "test_fail_metadata_path_update" on "app"."recents"
      `);
      await db.execute(sql`
        drop trigger if exists "test_fail_metadata_path_delete" on "app"."recents"
      `);
      await db.execute(sql`drop function if exists "app"."test_fail_metadata_path"()`);
    }
  });
});

// Office file rows go with their provider: a provider with no logins but
// past Office documents must still be removable (the FK cascades).
it("cascades office_files when their provider is deleted", async () => {
  await db.execute(sql`truncate table app.office_files, app.providers cascade`);
  const repos = createRepos(db);
  const officeFiles = createOfficeFileRepo(db);
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://office" });
  const file = await officeFiles.ensure({
    providerId: provider.id,
    rootName: "sftpgo",
    path: "alice/report.docx",
  });
  expect(await officeFiles.get(file.id)).not.toBeNull();
  await repos.providers.delete(provider.id);
  expect(await repos.providers.get(provider.id)).toBeNull();
  expect(await officeFiles.get(file.id)).toBeNull();
});

// A directory listing is unbounded, and `decorate` binds one parameter per
// entry, so a folder filled outside fdrive over raw SFTP or WebDAV can push
// these lookups past what one statement may carry. The listing below exceeds
// the protocol's 65535-parameter cap, so it only reaches PostgreSQL as valid
// messages at all because the repository splits it into bounded chunks.
describe("metadata lookups for oversized directory listings", () => {
  const listingSize = 66_000;
  const pathAt = (index: number) => `/big/file-${index}.txt`;
  const lastPath = pathAt(listingSize - 1);
  const boundaryPath = pathAt(PATH_CHUNK_SIZE);

  beforeEach(async () => {
    await db.execute(sql`
      truncate table
        app.file_tags,
        app.favorites,
        app.tags,
        app.identities,
        app.accounts,
        app.providers
      cascade
    `);
  });

  async function seedListing() {
    const repos = createRepos(db);
    const provider = await repos.providers.ensure({
      type: "sftpgo",
      baseUrl: "http://oversized",
    });
    const account = await repos.accounts.create({ displayName: "oversized" });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "oversized",
    });
    const work = await repos.tags.create(account.id, { name: "Work", color: null });
    const personal = await repos.tags.create(account.id, { name: "Personal", color: null });
    const listing = Array.from({ length: listingSize }, (_, index) => pathAt(index));
    // First, last, and both sides of a chunk boundary, so a merge that dropped
    // or duplicated a chunk could not still produce the expected result.
    const tagged = [pathAt(0), pathAt(PATH_CHUNK_SIZE - 1), boundaryPath, lastPath];
    const favorited = [pathAt(1), boundaryPath, lastPath];
    for (const path of tagged) {
      await repos.fileTags.setTags(identity.id, path, [work.id]);
    }
    await repos.fileTags.setTags(identity.id, boundaryPath, [work.id, personal.id]);
    for (const path of favorited) {
      await repos.favorites.add(identity.id, path, "file");
    }
    return { favorited, identity, listing, personal, repos, tagged, work };
  }

  it("returns every tag across a listing larger than one statement can bind", async () => {
    const { identity, listing, personal, repos, tagged, work } = await seedListing();

    const result = await repos.fileTags.tagsForPaths(identity.id, listing);

    expect(result.size).toBe(tagged.length);
    expect(result.get(pathAt(0))).toEqual([work.id]);
    expect(result.get(pathAt(PATH_CHUNK_SIZE - 1))).toEqual([work.id]);
    expect([...(result.get(boundaryPath) ?? [])].sort()).toEqual([personal.id, work.id].sort());
    expect(result.get(lastPath)).toEqual([work.id]);
    expect(result.has(pathAt(2))).toBe(false);
  });

  it("returns the same tags chunked as a per-path lookup that never chunks", async () => {
    const { identity, listing, repos, tagged } = await seedListing();

    const chunked = await repos.fileTags.tagsForPaths(identity.id, listing);
    const unchunked = new Map<string, string[]>();
    for (const path of tagged) {
      for (const [key, value] of await repos.fileTags.tagsForPaths(identity.id, [path])) {
        unchunked.set(key, value);
      }
    }
    const sorted = (byPath: Map<string, string[]>) =>
      new Map([...byPath].map(([path, ids]) => [path, [...ids].sort()]));

    expect(sorted(chunked)).toEqual(sorted(unchunked));
  });

  it("returns exactly the favorited subset of a listing larger than one statement", async () => {
    const { favorited, identity, listing, repos } = await seedListing();

    const result = await repos.favorites.has(identity.id, listing);

    expect(result).toEqual(new Set(favorited));
  });

  it("counts a path repeated across chunks once and ignores paths it never lists", async () => {
    const { favorited, identity, listing, repos, tagged, work } = await seedListing();
    const repeated = [...listing, pathAt(0), "/big/absent.txt"];

    const tags = await repos.fileTags.tagsForPaths(identity.id, repeated);

    expect(tags.size).toBe(tagged.length);
    expect(tags.get(pathAt(0))).toEqual([work.id]);
    expect(tags.has("/big/absent.txt")).toBe(false);
    expect(await repos.favorites.has(identity.id, repeated)).toEqual(new Set(favorited));
  });

  it("leaves an ordinary small listing and an empty one unchanged", async () => {
    const { identity, listing, repos, work } = await seedListing();
    const small = listing.slice(0, 4);

    expect(await repos.fileTags.tagsForPaths(identity.id, small)).toEqual(
      new Map([[pathAt(0), [work.id]]]),
    );
    expect(await repos.favorites.has(identity.id, small)).toEqual(new Set([pathAt(1)]));
    expect(await repos.fileTags.tagsForPaths(identity.id, [])).toEqual(new Map());
    expect(await repos.favorites.has(identity.id, [])).toEqual(new Set());
  });
});
