import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  AttachmentStore,
  BackupStore,
  captureSnapshot,
  digest,
  discoverBackups,
  fetchBackup,
  fileStream,
  inspectArchive,
  localBlobs,
  probeDestination,
  providerDestination,
  restoreArchive,
  verifyDelivery,
} from "@fdrive/backup";
import { createDb, migrate } from "@fdrive/db";
import { sftpgoModule } from "@fdrive/sftpgo";
import { startApacheWebdav, startPostgres, startSftpgo } from "@fdrive/testkit";
import { webdavModule } from "@fdrive/webdav";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, expect, it } from "vitest";
import { open, seal } from "../../src/auth/crypto.js";
import { rawBackupStorage } from "../../src/backups/module.js";
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
it("recovers durable metadata, exact bigint history, credentials, ZIPs and bytes into an isolated fresh database", async () => {
  const provider = randomUUID(),
    account = randomUUID(),
    user = randomUUID();
  await source.pool.query(
    "insert into app.providers(id,type,label,base_url,config) values($1,'sftpgo','Test','http://test.invalid','{}')",
    [provider],
  );
  await source.pool.query("insert into app.accounts(id) values($1)", [account]);
  await source.pool.query(
    "insert into app.identities(id,account_id,provider_id,external_username) values($1,$2,$3,'alice')",
    [user, account, provider],
  );
  await source.pool.query(
    "insert into app.credentials(identity_id,key_id,ciphertext) values($1,'master-v1',$2)",
    [user, Buffer.from(seal(master, Buffer.from('{"password":"test-secret"}'), user))],
  );
  await source.pool.query("insert into app.settings(key,value) values('setup.owner.v1',$1)", [
    JSON.stringify({ state: "complete", accountId: account }),
  ]);
  await source.pool.query("insert into idx.roots(name) values('documents')");
  await source.pool.query(
    "insert into idx.events(id,root_id,path,kind) values(9007199254740993,1,'report.pdf','upsert')",
  );
  const store = new BackupStore(source.pool);
  const config = await store.configuration();
  const attachments = new AttachmentStore(store, join(directory, "attachments"), {
    seal: (bytes, aad) => seal(master, bytes, aad),
    open: (bytes, aad) => open(master, bytes, aad),
  });
  await attachments.upload(
    { label: "Compose", filename: "compose.zip", sourceDate: null, notes: "Restore on fileserver" },
    Readable.from([Buffer.from("PK\x03\x04opaque zip fixture")]),
  );
  const recovery = join(directory, "desktop");
  await mkdir(recovery);
  await writeFile(join(recovery, "accepted.payload"), "native recovery data");
  const file = join(directory, "snapshot.age");
  const result = await captureSnapshot(
    {
      pool: source.pool,
      masterKey: master.toString("base64"),
      environment: {},
      async blobs(client) {
        return {
          sources: [
            ...(await store.attachments(client)).map((row) => attachments.source(row)),
            ...(await localBlobs(recovery, "desktop")),
          ],
          coverage: [],
        };
      },
    },
    {
      id: randomUUID(),
      installationId: config.installation_id,
      recipient: await identityToRecipient(identity),
      output: file,
    },
  );
  expect(result.manifest.coverage).toEqual([]);
  expect((await readFile(file)).includes(Buffer.from("test-secret"))).toBe(false);
  const inspection = await inspectArchive(file, identity);
  expect(inspection.manifest.tables["idx.events"]?.rows).toBe(1);
  const restored = await restoreArchive(
    restoreOptions(
      loadConfig({
        DATABASE_URL: container.connectionString,
        FDRIVE_MASTER_KEY: destinationMaster.toString("base64"),
      }),
      target.pool,
      file,
      identity,
      directory,
    ),
  );
  expect(restored.header.id).toBe(inspection.header.id);
  expect((await target.pool.query("select id::text from idx.events")).rows[0].id).toBe(
    "9007199254740993",
  );
  expect((await target.pool.query("select enabled from app.providers")).rows[0].enabled).toBe(
    false,
  );
  const credential = (await target.pool.query("select ciphertext from app.credentials")).rows[0]
    .ciphertext;
  expect(Buffer.from(open(destinationMaster, credential, user)).toString()).toContain(
    "test-secret",
  );
  const state = (
    await target.pool.query("select value from app.settings where key='backup.restore.v1'")
  ).rows[0].value;
  const restoredStore = new BackupStore(target.pool);
  const row = (await restoredStore.attachments())[0];
  expect(row).toBeDefined();
  if (!row) throw Error("Restored attachment missing");
  const bundles = new AttachmentStore(restoredStore, join(state.stateDirectory, "attachments"), {
    seal: (bytes, aad) => seal(destinationMaster, bytes, aad),
    open: (bytes, aad) => open(destinationMaster, bytes, aad),
  });
  const chunks = [];
  for await (const chunk of await bundles.download(row)) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toContain("opaque zip fixture");
  await expect(
    restoreArchive(
      restoreOptions(
        loadConfig({
          DATABASE_URL: container.connectionString,
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

it("delivers a large streamed snapshot to Apache WebDAV and SFTPGo destinations that restore without the source", async () => {
  const dav = await startApacheWebdav();
  const sftpgo = await startSftpgo();
  const timings: Record<string, Record<string, number>> = {};
  try {
    // 64 MiB of incompressible recovery bytes, streamed from disk rather than held in memory.
    const recovery = join(directory, "large-recovery");
    await mkdir(recovery, { recursive: true });
    await pipeline(
      Readable.from(
        (function* () {
          for (let i = 0; i < 64; i++) yield randomBytes(1024 * 1024);
        })(),
      ),
      createWriteStream(join(recovery, "large.payload")),
    );
    const store = new BackupStore(source.pool);
    const config = await store.configuration();
    const id = randomUUID();
    const file = join(directory, `${id}.fdrive.age`);
    let at = performance.now();
    const result = await captureSnapshot(
      {
        pool: source.pool,
        masterKey: master.toString("base64"),
        environment: {},
        blobs: async () => ({ sources: await localBlobs(recovery, "desktop"), coverage: [] }),
      },
      {
        id,
        installationId: config.installation_id,
        recipient: await identityToRecipient(identity),
        output: file,
      },
    );
    timings.capture = { captureMs: performance.now() - at, archiveBytes: Number(result.bytes) };
    expect(Number(result.bytes)).toBeGreaterThan(64 * 1024 * 1024);
    const local = await digest(fileStream(file));
    const targets = [
      {
        label: "apache-webdav",
        module: webdavModule,
        instance: { id: randomUUID(), baseUrl: dav.baseUrl, config: {} },
        credential: dav.credential,
      },
      {
        label: "sftpgo",
        module: sftpgoModule,
        instance: { id: randomUUID(), baseUrl: sftpgo.baseUrl, config: {} },
        credential: { username: "alice", password: "alice-password" },
      },
    ];
    for (const target of targets) {
      // Same wiring as the API's destination factory: a dedicated raw storage session with a
      // pinned username, confined to the reserved namespace under a private directory.
      const storage = await rawBackupStorage(
        target.module,
        target.instance,
        target.credential,
        target.credential.username,
      );
      const prefix = `backups/.fdrive-backups/${config.installation_id}`;
      await storage.mkdir(`/${prefix}`, { parents: true });
      const destination = providerDestination(storage, prefix);
      await probeDestination(destination);
      expect(await destination.list()).toEqual([]);
      const key = `${id}.fdrive.age`;
      at = performance.now();
      await verifyDelivery(destination, key, file);
      const transferAndReadbackMs = performance.now() - at;
      const completion = join(directory, `${target.label}-complete.json`);
      await writeFile(
        completion,
        JSON.stringify({
          format: 1,
          installationId: config.installation_id,
          id,
          createdAt: new Date().toISOString(),
          key,
          bytes: String(local.bytes),
          sha256: local.sha256,
          versionId: null,
          coverage: [],
        }),
      );
      await verifyDelivery(destination, `${id}.complete.json`, completion);
      expect((await discoverBackups(destination)).map((entry) => entry.id)).toEqual([id]);
      // Recover with fileserver access only: a fresh storage session and no source database.
      const independent = providerDestination(
        await rawBackupStorage(target.module, target.instance, target.credential),
        prefix,
      );
      const fetched = join(directory, `${target.label}-fetched.age`);
      at = performance.now();
      await fetchBackup(independent, id, fetched);
      const fetchMs = performance.now() - at;
      expect(await digest(fileStream(fetched))).toEqual(local);
      const database = `restore_${target.label.replace(/-/g, "_")}`;
      await source.pool.query(`create database ${database}`);
      const url = new URL(container.connectionString);
      url.pathname = `/${database}`;
      const fresh = createDb(url.toString());
      try {
        await migrate(fresh.db);
        at = performance.now();
        const restored = await restoreArchive(
          restoreOptions(
            loadConfig({
              DATABASE_URL: container.connectionString,
              FDRIVE_MASTER_KEY: destinationMaster.toString("base64"),
            }),
            fresh.pool,
            fetched,
            identity,
            directory,
          ),
        );
        timings[target.label] = {
          transferAndReadbackMs,
          fetchMs,
          restoreMs: performance.now() - at,
        };
        expect(restored.header.id).toBe(id);
        expect(
          (await fresh.pool.query("select count(*)::int as count from app.providers")).rows[0]
            .count,
        ).toBeGreaterThan(0);
      } finally {
        await fresh.close();
      }
    }
    const evaluation = fileURLToPath(
      new URL("../../../../.fdrive-workflow/evaluation/", import.meta.url),
    );
    await mkdir(evaluation, { recursive: true });
    await writeFile(
      join(evaluation, "backup-destinations.json"),
      JSON.stringify({ measuredAt: new Date().toISOString(), ...timings }, null, 2),
    );
  } finally {
    await dav.stop();
    await sftpgo.stop();
  }
}, 600_000);
