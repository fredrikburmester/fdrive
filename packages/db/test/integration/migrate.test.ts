import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationsThrough, SQUASHED_MIGRATIONS } from "@fdrive/testkit";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { is, sql } from "drizzle-orm";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CreateDbResult, createDb, type Db, migrate, schema } from "../../src/index.js";

let container: StartedPostgreSqlContainer;
let db: Db;
let close: () => Promise<void>;
const opened: CreateDbResult[] = [];

/** Every table the drizzle schema declares, as `schema.table`. */
const EXPECTED_TABLES = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => {
    const config = getTableConfig(table);
    return `${config.schema}.${config.name}`;
  })
  .sort();

/** The migrations this package ships. */
const SHIPPED_MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

interface JournalEntry {
  readonly tag: string;
  readonly when: number;
}

async function journal(folder: string): Promise<JournalEntry[]> {
  const parsed = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return parsed.entries;
}

/** The history drizzle records for `folder`'s migrations: each one's sha256 and journal date. */
async function expectedHistory(folder: string) {
  return Promise.all(
    (await journal(folder)).map(async (entry) => ({
      hash: createHash("sha256")
        .update(await readFile(path.join(folder, `${entry.tag}.sql`)))
        .digest("hex"),
      created_at: String(entry.when),
    })),
  );
}

/** A new, empty database named `name` on the test server. */
async function database(name: string): Promise<Db> {
  await db.execute(sql.raw(`create database ${name}`));
  const uri = new URL(container.getConnectionUri());
  uri.pathname = `/${name}`;
  const created = createDb(uri.toString());
  opened.push(created);
  return created.db;
}

/** A database named `name` that the migrations in `folder` built through `through`. */
async function migratedThrough(name: string, folder: string, through: string): Promise<Db> {
  const target = await database(name);
  const migrations = await migrationsThrough(folder, through);
  try {
    await runMigrations(target, { migrationsFolder: migrations });
  } finally {
    await rm(migrations, { recursive: true, force: true });
  }
  return target;
}

/** `pg_dump` of database `name`, from inside the container, without its random `\restrict` key. */
async function dump(name: string, ...options: string[]): Promise<string> {
  const result = await container.exec(["pg_dump", "--username", "fdrive", ...options, name]);
  if (result.exitCode !== 0) throw new Error(`pg_dump ${name}: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .join("\n");
}

const schemaOf = (name: string) => dump(name, "--schema-only");
/** Every row outside drizzle's bookkeeping, sequence positions included. */
const dataOf = (name: string) => dump(name, "--data-only", "--exclude-schema=drizzle");

async function history(target: Db) {
  const result = await target.execute<{ hash: string; created_at: string }>(sql`
    select hash, created_at::text from drizzle.__drizzle_migrations order by created_at, id`);
  return result.rows;
}

/** Every row of every `app` and `idx` table, as JSON, in a stable order. */
async function contents(target: Db): Promise<Record<string, Record<string, unknown>[]>> {
  const tables = await target.execute<{ name: string }>(sql`
    select table_schema || '.' || table_name as name from information_schema.tables
    where table_schema in ('app', 'idx') and table_type = 'BASE TABLE' order by 1`);
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of tables.rows) {
    const rows = await target.execute<{ rows: Record<string, unknown>[] }>(
      sql.raw(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') as rows
        from ${name} t`),
    );
    result[name] = rows.rows[0]?.rows ?? [];
  }
  return result;
}

const ALICE = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b1";
const ALICE_LOGIN = "00000000-0000-4000-8000-0000000000a2";
const BOB_LOGIN = "00000000-0000-4000-8000-0000000000b2";
const WORK_TAG = "00000000-0000-4000-8000-0000000000c1";

/** Rows as v0.7.0-rc.11 stores them, in every kind of table an owner fills. */
async function seedRows(older: Db): Promise<void> {
  await older.execute(sql`
    insert into app.accounts (id, display_name, is_admin) values
      (${ALICE}, 'Alice', true), (${BOB}, null, false)`);
  await older.execute(sql`
    insert into app.identities (id, account_id, username) values
      (${ALICE_LOGIN}, ${ALICE}, 'alice'), (${BOB_LOGIN}, ${BOB}, 'bob')`);
  await older.execute(sql`
    insert into app.local_users (username, password_hash, storage_limit) values
      ('alice', 'scrypt$16384$8$1$AA$AA', null), ('bob', 'scrypt$16384$8$1$BB$BB', 1000000)`);
  await older.execute(sql`
    insert into app.settings (key, value) values
      ('storage.id', '{"id":"00000000-0000-4000-8000-0000000000d1"}'),
      ('setup.owner.v1', ${JSON.stringify({ version: 1, state: "complete", accountId: ALICE })})`);
  await older.execute(sql`
    insert into app.trash_items (identity_id, original_path, name, kind, size, deleted_at,
      moving_from) values
      (${ALICE_LOGIN}, '/docs/report.pdf', 'report.pdf', 'file', 1234, '2026-11-14T10:00:00Z', null),
      (${ALICE_LOGIN}, '/photos/2024', '2024', 'dir', 0, '2026-11-13T09:00:00Z', null),
      (${BOB_LOGIN}, '/notes.txt', 'notes.txt', 'file', 12, '2026-11-12T08:00:00Z',
        '/.trash/.fdrive-move-v1/file/p/notes.txt/v/1')`);
  await older.execute(sql`
    insert into app.shares (identity_id, name, scope, paths, password_hash, max_downloads,
      used_downloads, description) values
      (${ALICE_LOGIN}, 'Report', 'read', array['/docs/report.pdf'], 'scrypt$1$8$1$AA$AA', 5, 2,
        'For Bob')`);
  await older.execute(sql`
    insert into app.tags (id, account_id, name, color) values (${WORK_TAG}, ${ALICE}, 'Work', 'blue')`);
  await older.execute(sql`
    insert into app.file_tags (identity_id, path, tag_id) values
      (${ALICE_LOGIN}, '/docs/a.txt', ${WORK_TAG})`);
  await older.execute(sql`
    insert into app.favorites (identity_id, path) values (${ALICE_LOGIN}, '/docs/a.txt')`);
  await older.execute(sql`
    insert into app.local_grants (owner_username, path, grantee_username, access) values
      ('alice', '/shared', 'bob', 'write')`);
  await older.execute(sql`
    insert into app.saved_searches (account_id, name, query, type) values
      (${ALICE}, 'Reports', 'report', 'all')`);
  await older.execute(sql`
    insert into app.api_tokens (account_id, identity_id, name, token_hash, access) values
      (${ALICE}, ${ALICE_LOGIN}, 'Laptop', 'token-hash', '{"mode":"read","paths":["/"]}')`);
  await older.execute(sql`
    insert into app.desktop_items (identity_id, path, kind) values
      (${ALICE_LOGIN}, '/docs/a.txt', 'file')`);
  await older.execute(sql`
    insert into idx.files (root_id, path, name, size, mtime_ns) values
      (1, 'alice/docs/a.txt', 'a.txt', 3, 1)`);
}

/** `rows` without the `original_path` of `app.desktop_items`, which the upgrade drops. */
function withoutDesktopOriginalPath(
  rows: Record<string, Record<string, unknown>[]>,
): Record<string, Record<string, unknown>[]> {
  const items = (rows["app.desktop_items"] ?? []).map(({ original_path: _, ...row }) => row);
  items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { ...rows, "app.desktop_items": items };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();

  const created = createDb(container.getConnectionUri());
  db = created.db;
  close = created.close;
}, 180_000);

afterAll(async () => {
  await Promise.all(opened.map((database) => database.close()));
  await close();
  await container.stop();
}, 180_000);

describe("migrate", () => {
  it("applies every migration and is a no-op the second time", async () => {
    await migrate(db);
    await expect(migrate(db)).resolves.toBeUndefined();
    // The files folder's index root is there before anything indexes it.
    const roots = await db.execute(sql`select id, name from idx.roots`);
    expect(roots.rows).toEqual([{ id: 1, name: "files" }]);
    // No setting either: the API creates the storage id when it first starts,
    // and a restore needs every backed-up table empty.
    const settings = await db.execute(sql`select key from app.settings`);
    expect(settings.rows).toEqual([]);
  });

  it("covers every app foreign key with an unconditional leading-column index", async () => {
    const missing = await db.execute(sql`
      select c.conrelid::regclass::text as table_name, c.conname
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'app'::regnamespace
        and not exists (
          select 1 from pg_index i
          join pg_class ix on ix.oid = i.indexrelid
          join pg_am am on am.oid = ix.relam
          where i.indrelid = c.conrelid and i.indisvalid
            and i.indpred is null and i.indexprs is null and am.amname = 'btree'
            and (i.indkey::smallint[])[0:cardinality(c.conkey) - 1] @> c.conkey
        )
    `);
    expect(missing.rows).toEqual([]);
  });

  it("indexes the idx read paths on their filter and sort columns", async () => {
    const expected: ReadonlyArray<{ readonly name: string; readonly definition: string }> = [
      { name: "changes_root_id_id_idx", definition: "USING btree (root_id, id)" },
      { name: "changes_created_at_idx", definition: "USING btree (created_at)" },
      { name: "ocr_log_status_at_idx", definition: "USING btree (status, at DESC NULLS LAST)" },
      {
        name: "scans_root_id_started_at_idx",
        definition: "USING btree (root_id, started_at DESC NULLS LAST)",
      },
    ];

    for (const { name, definition } of expected) {
      const result = await db.execute(sql`
        select indexdef
        from pg_indexes
        where schemaname = 'idx' and indexname = ${name}
      `);
      expect(result.rows, `idx.${name} should exist`).toHaveLength(1);
      expect(String(result.rows[0]?.indexdef).replaceAll('"', "")).toContain(definition);
    }
  });

  it("creates exactly the tables of the domain model", async () => {
    const result = await db.execute<{ name: string }>(sql`
      select table_schema || '.' || table_name as name
      from information_schema.tables
      where table_schema in ('app', 'idx')
    `);
    expect(EXPECTED_TABLES).toContain("idx.changes");
    expect(result.rows.map((row) => row.name).sort()).toEqual(EXPECTED_TABLES);
  });

  it("indexes a root, a file, and a chunk with a 384-dim embedding, then queries them back", async () => {
    const [root] = await db.insert(schema.roots).values({ name: "primary" }).returning();
    if (root === undefined) {
      throw new Error("expected root to be inserted");
    }

    const [file] = await db
      .insert(schema.files)
      .values({
        rootId: root.id,
        path: "/notes/hello.txt",
        name: "hello.txt",
        ext: "txt",
        size: 11,
        mtimeNs: 1_700_000_000_000_000_000n,
        textStatus: "done",
      })
      .returning();
    if (file === undefined) {
      throw new Error("expected file to be inserted");
    }

    const embedding = Array.from({ length: 384 }, (_, i) => i / 384);
    await db.insert(schema.chunks).values({
      fileId: file.id,
      idx: 0,
      text: "hello world",
      embedding,
    });

    const cosine = await db.execute(sql`
      select id, embedding <=> ${sql.raw(`'[${embedding.join(",")}]'`)}::vector as distance
      from idx.chunks
      where file_id = ${file.id}
    `);
    expect(cosine.rows).toHaveLength(1);
    expect(Number(cosine.rows[0]?.distance)).toBeCloseTo(0, 5);

    const fts = await db.execute(sql`
      select id
      from idx.chunks
      where tsv @@ to_tsquery('simple', 'hello:*')
        and file_id = ${file.id}
    `);
    expect(fts.rows).toHaveLength(1);
  });

  it("stores a 1024-dim image embedding and queries it back by cosine distance", async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024);
    await db.insert(schema.imageEmbeddings).values({
      contentKey: "sha-image-1",
      model: "google/siglip2-large-patch16-256",
      embedding,
    });

    const cosine = await db.execute(sql`
      select content_key, embedding <=> ${sql.raw(`'[${embedding.join(",")}]'`)}::vector as distance
      from app.image_embeddings
      where content_key = 'sha-image-1'
    `);
    expect(cosine.rows).toHaveLength(1);
    expect(Number(cosine.rows[0]?.distance)).toBeCloseTo(0, 5);
  });

  it("creates an HNSW cosine index on app.image_embeddings.embedding", async () => {
    const result = await db.execute(sql`
      select indexdef
      from pg_indexes
      where schemaname = 'app' and tablename = 'image_embeddings' and indexname = 'image_embeddings_hnsw_idx'
    `);
    expect(result.rows).toHaveLength(1);
    const indexDef = String(result.rows[0]?.indexdef);
    expect(indexDef).toContain("USING hnsw");
    expect(indexDef).toContain("vector_cosine_ops");
  });

  it("rejects a duplicate (root_id, path) pair in idx.files", async () => {
    const [root] = await db.insert(schema.roots).values({ name: "duplicate-root" }).returning();
    if (root === undefined) {
      throw new Error("expected root to be inserted");
    }

    await db.insert(schema.files).values({
      rootId: root.id,
      path: "/dup.txt",
      name: "dup.txt",
      size: 1,
      mtimeNs: 1n,
    });

    await expect(
      db.insert(schema.files).values({
        rootId: root.id,
        path: "/dup.txt",
        name: "dup.txt",
        size: 2,
        mtimeNs: 2n,
      }),
    ).rejects.toThrow();
  });

  it("refuses an API token without an access level", async () => {
    const error = await db
      .execute(sql`
        insert into app.api_tokens (account_id, identity_id, name, token_hash)
        values (gen_random_uuid(), gen_random_uuid(), 'Old', 'old-hash')
      `)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ cause: { code: "23502", column: "access" } });
  });
});

describe("the squashed history", () => {
  const SQUASHED_0047 = "0047_drop_desktop_original_path";
  let fresh: Db;

  beforeAll(async () => {
    fresh = await database("new_install");
    await migrate(fresh);
  });

  it("dates the baseline as the old 0000, so databases that ran the old history skip it", async () => {
    const shipped = await journal(SHIPPED_MIGRATIONS);
    const squashed = await journal(SQUASHED_MIGRATIONS);
    expect(shipped.slice(0, 2).map((entry) => entry.tag)).toEqual([
      "0000_baseline",
      "0001_squash_history",
    ]);
    expect(shipped[0]?.when).toBe(squashed[0]?.when);
    expect(shipped[1]?.when).toBeGreaterThan(squashed.at(-1)?.when ?? Number.POSITIVE_INFINITY);
  });

  it("builds from the baseline exactly the schema and rows the squashed history built", async () => {
    await migratedThrough("baseline_only", SHIPPED_MIGRATIONS, "0001_squash_history");
    await migratedThrough("squashed_history", SQUASHED_MIGRATIONS, SQUASHED_0047);

    const schema = await schemaOf("baseline_only");
    expect(schema).toContain("CREATE TABLE app.trash_items (");
    expect(schema).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(schema).toBe(await schemaOf("squashed_history"));
    const data = await dataOf("baseline_only");
    // The one row both seed: the files folder's index root.
    expect(data).toContain("1\tfiles");
    expect(data).toBe(await dataOf("squashed_history"));
  });

  it("records the shipped migrations on a new install, the baseline first", async () => {
    expect(await history(fresh)).toEqual(await expectedHistory(SHIPPED_MIGRATIONS));
  });

  it.each([
    ["0046_trash_items", "v0.7.0-rc.11"],
    [SQUASHED_0047, "main's edge build"],
  ])("upgrades a database at %s (%s) in place, keeping every row", async (through) => {
    const name = `at_${through.slice(0, 4)}`;
    const older = await migratedThrough(name, SQUASHED_MIGRATIONS, through);
    await seedRows(older);
    if (through === "0046_trash_items")
      await older.execute(sql`update app.desktop_items set original_path = '/docs/old.txt'`);
    const before = withoutDesktopOriginalPath(await contents(older));
    expect(before["app.trash_items"]).toHaveLength(3);

    await migrate(older);

    expect(withoutDesktopOriginalPath(await contents(older))).toEqual(before);
    expect(await schemaOf(name)).toBe(await schemaOf("new_install"));
    expect(await history(older)).toEqual(await history(fresh));
    // Then it is a database like any other: the next start migrates nothing.
    await migrate(older);
    expect(await history(older)).toEqual(await history(fresh));
  });

  it("refuses a database older than v0.7.0-rc.11 and leaves it as it was", async () => {
    const older = await migratedThrough("at_0045", SQUASHED_MIGRATIONS, "0045_drop_providers");
    await older.execute(sql`insert into app.accounts (id) values (${ALICE})`);
    await older.execute(sql`
      insert into app.identities (account_id, username) values (${ALICE}, 'alice')`);
    const schemaBefore = await schemaOf("at_0045");
    const historyBefore = await history(older);
    const rowsBefore = await contents(older);

    const error = await migrate(older).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      cause: {
        message: "fdrive cannot upgrade this database: it is older than v0.7.0-rc.11",
        hint: "Start fdrive v0.7.0-rc.11 on it once, then this release.",
      },
    });
    expect(await schemaOf("at_0045")).toBe(schemaBefore);
    expect(await history(older)).toEqual(historyBefore);
    expect(historyBefore).toHaveLength(46);
    expect(await contents(older)).toEqual(rowsBefore);
  });

  it("refuses a history with an entry no release wrote and leaves it as it was", async () => {
    const older = await migratedThrough("unknown_entry", SQUASHED_MIGRATIONS, "0046_trash_items");
    await older.execute(sql`
      insert into drizzle.__drizzle_migrations (hash, created_at) values (${"0".repeat(64)}, 1)`);
    const schemaBefore = await schemaOf("unknown_entry");
    const historyBefore = await history(older);

    const error = await migrate(older).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      cause: {
        message:
          "fdrive cannot upgrade this database: its migration history has entries no fdrive release wrote",
      },
    });
    expect(await schemaOf("unknown_entry")).toBe(schemaBefore);
    expect(await history(older)).toEqual(historyBefore);
  });

  it("builds the same schema from the SQL files alone, as the indexer's and OCR's tests do", async () => {
    const raw = await database("raw_files");
    const files = (await readdir(SHIPPED_MIGRATIONS)).filter((name) => name.endsWith(".sql"));
    for (const file of files.sort()) {
      const text = await readFile(path.join(SHIPPED_MIGRATIONS, file), "utf8");
      for (const statement of text.split("--> statement-breakpoint"))
        if (statement.trim()) await raw.execute(sql.raw(statement));
    }

    const schemas = ["--schema=app", "--schema=idx"];
    expect(await dump("raw_files", "--schema-only", ...schemas)).toBe(
      await dump("new_install", "--schema-only", ...schemas),
    );
    expect(await dump("raw_files", "--data-only", ...schemas)).toBe(
      await dump("new_install", "--data-only", ...schemas),
    );
  });
});
