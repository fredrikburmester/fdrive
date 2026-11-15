import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActivityFacts, PersonalActivityEvidence, PersonalActivitySource } from "@fdrive/contracts";
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

/**
 * Runs `body` against a second database migrated up to, but not including,
 * migration `tag`, so it can seed rows the way an older release stored them.
 */
async function withDatabaseBefore(tag: string, body: (older: Db) => Promise<void>) {
  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
  const migrations = await mkdtemp(path.join(tmpdir(), "fdrive-migrations-"));
  const name = `before_${tag.slice(0, 4)}`;
  await db.execute(sql.raw(`create database ${name}`));
  const uri = new URL(container.getConnectionUri());
  uri.pathname = `/${name}`;
  const older = createDb(uri.toString());
  try {
    await cp(folder, migrations, { recursive: true });
    const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8"));
    const last = journal.entries.findIndex((entry: { tag: string }) => entry.tag === tag);
    if (last < 0) throw new Error(`no migration ${tag}`);
    journal.entries = journal.entries.slice(0, last);
    await writeFile(path.join(migrations, "meta/_journal.json"), JSON.stringify(journal));
    await runMigrations(older.db, { migrationsFolder: migrations });
    await body(older.db);
  } finally {
    await older.close();
    await rm(migrations, { recursive: true, force: true });
  }
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
    await withDatabaseBefore("0030_drop_legacy_tokens_and_moves", async (older) => {
      const [account] = await older.insert(schema.accounts).values({}).returning();
      const [provider] = await older
        .insert(schema.providers)
        .values({ type: "local", baseUrl: "local" })
        .returning();
      if (account === undefined || provider === undefined) throw new Error("expected rows");
      const [identity] = await older
        .insert(schema.identities)
        .values({ accountId: account.id, providerId: provider.id, externalUsername: "alice" })
        .returning();
      if (identity === undefined) throw new Error("expected an identity");
      // Its user, so the next migration keeps the login.
      await older.insert(schema.localUsers).values({ username: "alice", passwordHash: "x" });
      await older.execute(sql`
        insert into app.api_tokens (account_id, identity_id, name, token_hash, access) values
          (${account.id}, ${identity.id}, 'Old', 'old-hash', null),
          (${account.id}, ${identity.id}, 'Scoped', 'scoped-hash', '{"mode":"read","paths":["/"]}')
      `);

      await migrate(older);

      const kept = await older.execute<{ name: string }>(sql`select name from app.api_tokens`);
      expect(kept.rows.map((row) => row.name)).toEqual(["Scoped"]);
      const moves = await older.execute<{ table: string | null }>(
        sql`select to_regclass('idx.moves')::text as table`,
      );
      expect(moves.rows).toEqual([{ table: null }]);
    });
  });

  it("leaves personal activity with nothing only remote storage produced, so every event parses", async () => {
    await withDatabaseBefore("0034_activity_without_provider_values", async (older) => {
      const [account] = await older.insert(schema.accounts).values({}).returning();
      const [provider] = await older
        .insert(schema.providers)
        .values({ type: "local", baseUrl: "local", label: "Local folder" })
        .returning();
      if (account === undefined || provider === undefined) throw new Error("expected rows");
      const [identity] = await older
        .insert(schema.identities)
        .values({ accountId: account.id, providerId: provider.id, externalUsername: "alice" })
        .returning();
      if (identity === undefined) throw new Error("expected an identity");
      const owner = account.id;
      const file = "00000000-0000-4000-8000-000000000001";
      const trashed = "00000000-0000-4000-8000-000000000002";
      const listed = "00000000-0000-4000-8000-000000000003";
      await older.execute(sql`
        insert into app.activity_storage_identities (identity_id, provider_id, provider_type, label)
          values (${identity.id}, ${provider.id}, 'local', 'Local folder')`);
      await older.execute(sql`
        insert into app.activity_files (id, identity_id, kind, virtual_path, state)
          values (${file}, ${identity.id}, 'file', '/a.txt', 'unknown')`);
      await older.execute(sql`
        insert into app.activity_events (id, owner_account_id, owner_sequence, actor_account_id,
          identity_id, file_id, class, action, stage, outcome, source, evidence, sort_at,
          idempotency_key, before, after)
        values
          (${trashed}, ${owner}, 1, ${owner}, ${identity.id}, ${file}, 'action', 'file.trash',
            'outcome', 'success', 'web', 'server_confirmed', now(), 'trash',
            '{"path":"/a.txt","trashStrategy":"fdrive_move"}',
            '{"path":"/a.txt","trashLeaf":"/.trash/a.txt","trashStrategy":"sftpgo_rule"}'),
          (${listed}, ${owner}, 2, null, ${identity.id}, ${file}, 'observation',
            'observation.location_missing', 'outcome', 'unknown', 'refresh', 'refresh_comparison',
            now(), 'listing', '{"path":"/a.txt"}', null)`);
      await older.execute(sql`
        insert into app.activity_event_subjects (owner_account_id, event_id, identity_id, file_id,
          role, subject_ordinal, virtual_path_snapshot)
          values (${owner}, ${listed}, ${identity.id}, ${file}, 'primary', 0, '/a.txt')`);
      await older.execute(sql`
        insert into app.activity_revisions (file_id, identity_id, owner_account_id, event_id,
          provider_version) values (${file}, ${identity.id}, ${owner}, ${trashed}, 'etag')`);
      await older.execute(sql`
        insert into app.activity_observation_state (owner_account_id, identity_id, file_id,
          prior_generation, discrepancy, evidence_fingerprint, event_id, last_check_at)
          values (${owner}, ${identity.id}, ${file}, 0, 'observation.location_missing', 'x',
            ${listed}, now())`);

      await migrate(older);

      const events = await older.execute<{
        id: string;
        source: string;
        evidence: string;
        before: unknown;
        after: unknown;
        detail: unknown;
      }>(sql`select id, source, evidence, before, after, detail from app.activity_events`);
      expect(events.rows.map((row) => row.id)).toEqual([trashed]);
      for (const row of events.rows) {
        expect(PersonalActivitySource.safeParse(row.source).success).toBe(true);
        expect(PersonalActivityEvidence.safeParse(row.evidence).success).toBe(true);
        for (const facts of [row.before, row.after, row.detail])
          expect(ActivityFacts.nullable().safeParse(facts).success).toBe(true);
      }
      expect(events.rows[0]?.after).toEqual({ path: "/a.txt", trashLeaf: "/.trash/a.txt" });
      const leftovers = await older.execute(sql`
        select (select count(*) from app.activity_event_subjects)::int as subjects,
          (select count(*) from app.activity_observation_state)::int as states`);
      expect(leftovers.rows).toEqual([{ subjects: 0, states: 0 }]);
      const logins = await older.execute(sql`select * from app.activity_storage_identities`);
      expect(logins.rows).toEqual([{ identity_id: identity.id, label: "alice" }]);
      const revisions = await older.execute<{ column: string }>(sql`
        select column_name as column from information_schema.columns
        where table_schema = 'app' and table_name = 'activity_revisions'`);
      expect(revisions.rows.map((row) => row.column)).not.toContain("provider_version");
    });
  });

  it("keeps only logins with a user of the same name, and drops the stored passwords", async () => {
    await withDatabaseBefore("0033_local_passwords", async (older) => {
      const [local] = await older
        .insert(schema.providers)
        .values({ type: "local", baseUrl: "local" })
        .returning();
      const [webdav] = await older
        .insert(schema.providers)
        .values({ type: "webdav", baseUrl: "http://dav.invalid", enabled: false })
        .returning();
      if (local === undefined || webdav === undefined) throw new Error("expected rows");
      const login = async (providerId: string, externalUsername: string) => {
        const [account] = await older.insert(schema.accounts).values({}).returning();
        if (account === undefined) throw new Error("expected an account");
        await older
          .insert(schema.identities)
          .values({ accountId: account.id, providerId, externalUsername });
        return account.id;
      };
      const owner = await login(local.id, "alice");
      await login(local.id, "Bob"); // a removed user's login under another spelling of bob
      await login(webdav.id, "alice-dav"); // a login on storage fdrive no longer has
      for (const username of ["alice", "bob", "carol"])
        await older.insert(schema.localUsers).values({ username, passwordHash: "x" });
      // A files folder destination with a sealed password, and a bucket.
      await older.execute(sql`
        insert into app.backup_destinations (id, revision, name, type, config, secret) values
          (gen_random_uuid(), gen_random_uuid(), 'Files', 'provider', '{}', '\\x01'),
          (gen_random_uuid(), gen_random_uuid(), 'Bucket', 's3', '{}', '\\x01')
      `);
      await older.execute(sql`
        insert into app.settings (key, value) values
          ('setup.initialized.v1', 'true'),
          ('setup.owner.v1', ${JSON.stringify({ version: 1, state: "complete", accountId: owner })})
      `);

      await migrate(older);

      const logins = await older.execute<{ name: string }>(
        sql`select external_username as name from app.identities order by 1`,
      );
      expect(logins.rows.map((row) => row.name)).toEqual(["alice"]);
      // bob and carol had no login of their own name; alice keeps hers.
      const users = await older.execute<{ name: string }>(
        sql`select username as name from app.local_users order by 1`,
      );
      expect(users.rows.map((row) => row.name)).toEqual(["alice"]);
      const settings = await older.execute<{ key: string }>(
        sql`select key from app.settings where key like 'setup.%' order by 1`,
      );
      expect(settings.rows).toEqual([{ key: "setup.owner.v1" }]);
      const destinations = await older.execute<{ type: string }>(
        sql`select type from app.backup_destinations`,
      );
      expect(destinations.rows).toEqual([{ type: "s3" }]);
      const credentials = await older.execute<{ table: string | null }>(
        sql`select to_regclass('app.credentials')::text as table`,
      );
      expect(credentials.rows).toEqual([{ table: null }]);
    });
  });

  it("keeps the Trash bindings that know their leaf, drops the rest, and the old Trash settings", async () => {
    await withDatabaseBefore("0038_trash_leaf_required", async (older) => {
      const [account] = await older.insert(schema.accounts).values({}).returning();
      const [provider] = await older
        .insert(schema.providers)
        .values({ type: "local", baseUrl: "local" })
        .returning();
      if (account === undefined || provider === undefined) throw new Error("expected rows");
      const [identity] = await older
        .insert(schema.identities)
        .values({ accountId: account.id, providerId: provider.id, externalUsername: "alice" })
        .returning();
      if (identity === undefined) throw new Error("expected an identity");
      const owner = account.id;
      const bound = "00000000-0000-4000-8000-000000000021";
      const unresolved = "00000000-0000-4000-8000-000000000022";
      const file = "00000000-0000-4000-8000-000000000023";
      await older.execute(sql`
        insert into app.activity_storage_identities (identity_id, label)
          values (${identity.id}, 'alice')`);
      await older.execute(sql`
        insert into app.activity_files (id, identity_id, kind, virtual_path, state)
          values (${file}, ${identity.id}, 'file', '/a.txt', 'trashed')`);
      await older.execute(sql`
        insert into app.activity_events (id, owner_account_id, owner_sequence, actor_account_id,
          identity_id, file_id, class, action, stage, outcome, source, evidence, sort_at,
          idempotency_key, before, after)
        values
          (${bound}, ${owner}, 1, ${owner}, ${identity.id}, ${file}, 'action', 'file.trash',
            'outcome', 'success', 'web', 'server_confirmed', now(), 'bound', '{}', '{}'),
          (${unresolved}, ${owner}, 2, ${owner}, ${identity.id}, ${file}, 'action', 'file.trash',
            'outcome', 'success', 'web', 'server_confirmed', now(), 'unresolved', '{}', '{}')`);
      await older.execute(sql`
        insert into app.activity_trash_bindings (file_id, identity_id, owner_account_id, event_id,
          original_virtual_path, trash_virtual_leaf, state) values
          (${file}, ${identity.id}, ${owner}, ${bound}, '/a.txt',
            '/.trash/.fdrive-move-v1/file/p/a.txt/v/1', 'bound'),
          (${file}, ${identity.id}, ${owner}, ${unresolved}, '/a.txt', null, 'unresolved')`);
      await older.execute(sql`
        insert into app.settings (key, value) values
          (${`trash.configuration.${provider.id}`}, '{"enabled":true,"path":"/Bin"}'),
          ('storage.name', '{"name":"Home"}')`);

      await migrate(older);

      const bindings = await older.execute(
        sql`select event_id, state from app.activity_trash_bindings`,
      );
      expect(bindings.rows).toEqual([{ event_id: bound, state: "bound" }]);
      await expect(
        older.execute(sql`
          insert into app.activity_trash_bindings (file_id, identity_id, owner_account_id,
            event_id, original_virtual_path, trash_virtual_leaf, state)
            values (${file}, ${identity.id}, ${owner}, ${unresolved}, '/a.txt', null, 'bound')`),
      ).rejects.toThrow();
      const settings = await older.execute(sql`select key from app.settings order by key`);
      expect(settings.rows).toEqual([{ key: "storage.name" }]);
    });
  });

  it("keeps only bucket destinations and drops configuration ZIPs", async () => {
    await withDatabaseBefore("0036_backups_s3_only", async (older) => {
      const files = "00000000-0000-4000-8000-000000000011";
      const bucket = "00000000-0000-4000-8000-000000000012";
      const run = "00000000-0000-4000-8000-000000000013";
      await older.execute(sql`
        insert into app.backup_destinations (id, revision, name, type, config, secret) values
          (${files}, gen_random_uuid(), 'Files', 'provider', '{}', '\\x01'),
          (${bucket}, gen_random_uuid(), 'Bucket', 's3', '{}', '\\x01')`);
      await older.execute(sql`
        insert into app.backup_runs (id, request, recipient) values (${run}, '{}', 'age1')`);
      await older.execute(sql`
        insert into app.backup_deliveries (run_id, destination_id, destination_revision, name)
          values (${run}, ${files}, gen_random_uuid(), 'Files'),
            (${run}, ${bucket}, gen_random_uuid(), 'Bucket')`);
      await older.execute(sql`
        insert into app.backup_attachments (version_id, label, filename, bytes, sha256, secret)
          values (gen_random_uuid(), 'Config', 'config.zip', '1', 'x', '\\x01')`);
      await older.execute(sql`
        insert into app.settings (key, value) values
          (${`backup.inventory.${run}`}, '{"attachmentVersions":[]}'),
          ('backup.worker.v1', '{}')`);

      await migrate(older);

      const destinations = await older.execute(sql`select id from app.backup_destinations`);
      expect(destinations.rows).toEqual([{ id: bucket }]);
      const deliveries = await older.execute(sql`select destination_id from app.backup_deliveries`);
      expect(deliveries.rows).toEqual([{ destination_id: bucket }]);
      const runs = await older.execute(sql`select id from app.backup_runs`);
      expect(runs.rows).toEqual([{ id: run }]);
      const settings = await older.execute(sql`select key from app.settings order by key`);
      expect(settings.rows).toEqual([{ key: "backup.worker.v1" }]);
      const attachments = await older.execute<{ table: string | null }>(
        sql`select to_regclass('app.backup_attachments')::text as table`,
      );
      expect(attachments.rows).toEqual([{ table: null }]);
    });
  });
});
