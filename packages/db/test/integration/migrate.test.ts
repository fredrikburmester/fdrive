import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, migrate, schema } from "../../src/index.js";

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
  { schema: "app", table: "recents" },
  { schema: "app", table: "thumbnails" },
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
