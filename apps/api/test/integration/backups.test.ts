import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackupStore,
  captureSnapshot,
  inspectArchive,
  localBlobs,
  restoreArchive,
} from "@fdrive/backup";
import { createDb, migrate } from "@fdrive/db";
import { startPostgres } from "@fdrive/testkit";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, expect, it } from "vitest";
import { restoreOptions } from "../../src/backups/recovery.js";
import { loadConfig } from "../../src/config.js";

let source: ReturnType<typeof createDb>;
let target: ReturnType<typeof createDb>;
let container: Awaited<ReturnType<typeof startPostgres>>;
let directory: string;
const master = randomBytes(32);
const destinationMaster = randomBytes(32);
let identity: string;
beforeAll(async () => {
  container = await startPostgres();
  source = createDb(container.connectionString);
  await migrate(source.db);
  await source.pool.query("create database restore_target");
  const url = new URL(container.connectionString);
  url.pathname = "/restore_target";
  target = createDb(url.toString());
  await migrate(target.db);
  directory = await mkdtemp(join(tmpdir(), "fdrive-backup-test-"));
  identity = await generateIdentity();
}, 180_000);
afterAll(async () => {
  await source?.close();
  await target?.close();
  await container?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("recovers durable metadata, exact bigint history, users and recovery files into an isolated fresh database", async () => {
  const provider = randomUUID(),
    account = randomUUID(),
    user = randomUUID();
  await source.pool.query(
    "insert into app.providers(id,type,label,base_url,config) values($1,'local','Test','local','{}')",
    [provider],
  );
  await source.pool.query("insert into app.accounts(id) values($1)", [account]);
  await source.pool.query(
    "insert into app.identities(id,account_id,provider_id,external_username) values($1,$2,$3,'owner')",
    [user, account, provider],
  );
  await source.pool.query(
    "insert into app.local_users(username,password_hash) values('owner','scrypt$fixture')",
  );
  await source.pool.query("insert into app.settings(key,value) values('setup.owner.v1',$1)", [
    JSON.stringify({ state: "complete", accountId: account }),
  ]);
  await source.pool.query(
    "insert into idx.scans(id,root_id,started_at) values(9007199254740993,1,now())",
  );
  const store = new BackupStore(source.pool);
  const config = await store.configuration();
  const recovery = join(directory, "office");
  await mkdir(recovery);
  await writeFile(join(recovery, "accepted.payload"), "office recovery data");
  const file = join(directory, "snapshot.age");
  const result = await captureSnapshot(
    {
      pool: source.pool,
      masterKey: master.toString("base64"),
      environment: {},
      blobs: async () => ({ sources: await localBlobs(recovery, "office"), coverage: [] }),
    },
    {
      id: randomUUID(),
      installationId: config.installation_id,
      recipient: await identityToRecipient(identity),
      output: file,
    },
  );
  expect(result.manifest.coverage).toEqual([]);
  // Encrypted: not even the password hash is readable in the archive.
  expect((await readFile(file)).includes(Buffer.from("scrypt$fixture"))).toBe(false);
  const inspection = await inspectArchive(file, identity);
  expect(inspection.manifest.tables["idx.scans"]?.rows).toBe(1);
  const restored = await restoreArchive(
    restoreOptions(
      loadConfig({
        DATABASE_URL: container.connectionString,
        FDRIVE_STORAGE_ROOT: "/srv/files",
        FDRIVE_MASTER_KEY: destinationMaster.toString("base64"),
      }),
      target.pool,
      file,
      identity,
      directory,
    ),
  );
  expect(restored.header.id).toBe(inspection.header.id);
  expect((await target.pool.query("select id::text from idx.scans")).rows[0].id).toBe(
    "9007199254740993",
  );
  expect((await target.pool.query("select enabled from app.providers")).rows[0].enabled).toBe(
    false,
  );
  expect(
    (await target.pool.query("select username,password_hash from app.local_users")).rows,
  ).toEqual([{ username: "owner", password_hash: "scrypt$fixture" }]);
  const state = (
    await target.pool.query("select value from app.settings where key='backup.restore.v1'")
  ).rows[0].value;
  expect(await readFile(join(state.stateDirectory, "blobs-0"), "utf8")).toBe(
    "office recovery data",
  );
  await expect(
    restoreArchive(
      restoreOptions(
        loadConfig({
          DATABASE_URL: container.connectionString,
          FDRIVE_STORAGE_ROOT: "/srv/files",
          FDRIVE_MASTER_KEY: destinationMaster.toString("base64"),
        }),
        target.pool,
        file,
        identity,
        directory,
      ),
    ),
  ).rejects.toThrow("not empty");
}, 180_000);
