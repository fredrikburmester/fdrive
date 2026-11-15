import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { is, sql } from "drizzle-orm";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, migrate, schema } from "../../src/index.js";

let container: StartedPostgreSqlContainer;
let db: Db;
let close: () => Promise<void>;

/** Every table the drizzle schema declares, as `schema.table`. */
const EXPECTED_TABLES = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => {
    const config = getTableConfig(table);
    return `${config.schema}.${config.name}`;
  })
  .sort();

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

  it("deletes the tokens made before access levels, and only those", async () => {
    // Migrate a second database up to the migration before the one that drops them.
    const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const before = await mkdtemp(path.join(tmpdir(), "fdrive-migrations-"));
    await db.execute(sql`create database before_access_levels`);
    const uri = new URL(container.getConnectionUri());
    uri.pathname = "/before_access_levels";
    const older = createDb(uri.toString());
    try {
      await cp(folder, before, { recursive: true });
      const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8"));
      const last = journal.entries.findIndex(
        (entry: { tag: string }) => entry.tag === "0030_drop_legacy_tokens_and_moves",
      );
      journal.entries = journal.entries.slice(0, last);
      await writeFile(path.join(before, "meta/_journal.json"), JSON.stringify(journal));
      await runMigrations(older.db, { migrationsFolder: before });

      const [account] = await older.db.insert(schema.accounts).values({}).returning();
      const [provider] = await older.db
        .insert(schema.providers)
        .values({ type: "local", baseUrl: "local" })
        .returning();
      if (account === undefined || provider === undefined) throw new Error("expected rows");
      const [identity] = await older.db
        .insert(schema.identities)
        .values({ accountId: account.id, providerId: provider.id, externalUsername: "alice" })
        .returning();
      if (identity === undefined) throw new Error("expected an identity");
      await older.db.execute(sql`
        insert into app.api_tokens (account_id, identity_id, name, token_hash, access) values
          (${account.id}, ${identity.id}, 'Old', 'old-hash', null),
          (${account.id}, ${identity.id}, 'Scoped', 'scoped-hash', '{"mode":"read","paths":["/"]}')
      `);

      await migrate(older.db);

      const kept = await older.db.execute<{ name: string }>(sql`select name from app.api_tokens`);
      expect(kept.rows.map((row) => row.name)).toEqual(["Scoped"]);
      const moves = await older.db.execute<{ table: string | null }>(
        sql`select to_regclass('idx.moves')::text as table`,
      );
      expect(moves.rows).toEqual([{ table: null }]);
    } finally {
      await older.close();
      await rm(before, { recursive: true, force: true });
    }
  });
});
