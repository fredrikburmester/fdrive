import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, migrate, schema } from "../../src/index.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/", import.meta.url));

/** A copy of the migrations folder that ends at `last`, to leave a database as an older fdrive did. */
async function migrationsUpTo(last: string): Promise<string> {
  const journal = JSON.parse(await readFile(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const end = journal.entries.findIndex((entry) => entry.tag === last);
  if (end < 0) throw new Error(`no migration ${last}`);
  const entries = journal.entries.slice(0, end + 1);
  const folder = await mkdtemp(join(tmpdir(), "fdrive-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await copyFile(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

let container: StartedPostgreSqlContainer;
let db: Db;
let close: () => Promise<void>;

const EXPECTED_TABLES: ReadonlyArray<{ readonly schema: string; readonly table: string }> = [
  { schema: "app", table: "providers" },
  { schema: "app", table: "accounts" },
  { schema: "app", table: "identities" },
  { schema: "app", table: "credentials" },
  { schema: "app", table: "sessions" },
  { schema: "app", table: "api_tokens" },
  { schema: "app", table: "tags" },
  { schema: "app", table: "file_tags" },
  { schema: "app", table: "favorites" },
  { schema: "app", table: "folder_views" },
  { schema: "app", table: "recents" },
  { schema: "app", table: "thumbnails" },
  { schema: "app", table: "image_embeddings" },
  { schema: "app", table: "wopi_locks" },
  { schema: "app", table: "shares" },
  { schema: "app", table: "settings" },
  { schema: "idx", table: "roots" },
  { schema: "idx", table: "files" },
  { schema: "idx", table: "chunks" },
  { schema: "idx", table: "scans" },
  { schema: "idx", table: "moves" },
  { schema: "idx", table: "events" },
  { schema: "idx", table: "schema_version" },
];

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
  await close();
  await container.stop();
}, 180_000);

describe("migrate", () => {
  it("applies every migration and is a no-op the second time", async () => {
    await migrate(db);
    await expect(migrate(db)).resolves.toBeUndefined();
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
      { name: "moves_root_id_idx", definition: "USING btree (root_id)" },
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

  it("creates every table from the domain model", async () => {
    for (const { schema: schemaName, table } of EXPECTED_TABLES) {
      const result = await db.execute(sql`
        select 1
        from information_schema.tables
        where table_schema = ${schemaName} and table_name = ${table}
      `);
      expect(result.rows, `${schemaName}.${table} should exist`).toHaveLength(1);
    }
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
});

describe("migration 0019", () => {
  it("switches off WebDAV and S3 rows and keeps them for the logins that reference them", async () => {
    await db.execute(sql.raw("create database fdrive_storage_types"));
    const url = new URL(container.getConnectionUri());
    url.pathname = "/fdrive_storage_types";
    const older = createDb(url.toString());
    const folder = await migrationsUpTo("0018_local_grants");
    try {
      await runMigrations(older.db, { migrationsFolder: folder });
      await older.db.execute(sql`
        insert into app.providers (type, base_url, enabled, managed_by_env) values
          ('local', 'local', true, true),
          ('webdav', 'http://dav.test/', true, true),
          ('s3', 'http://s3.test/bucket', true, false)`);
      await older.db.execute(sql`
        insert into app.accounts (id) values ('00000000-0000-4000-8000-000000000001')`);
      await older.db.execute(sql`
        insert into app.identities (account_id, provider_id, external_username)
        select '00000000-0000-4000-8000-000000000001', id, 'alice'
        from app.providers where type = 'webdav'`);

      await migrate(older.db);

      const rows = await older.db.execute<{
        type: string;
        enabled: boolean;
        managed_by_env: boolean;
      }>(sql`select type, enabled, managed_by_env from app.providers order by type`);
      expect(rows.rows).toEqual([
        { type: "local", enabled: true, managed_by_env: true },
        { type: "s3", enabled: false, managed_by_env: false },
        { type: "webdav", enabled: false, managed_by_env: false },
      ]);
      const logins = await older.db.execute(sql`select 1 from app.identities`);
      expect(logins.rows).toHaveLength(1);
    } finally {
      await older.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
