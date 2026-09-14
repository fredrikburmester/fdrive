import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { createDb, migrate } from "@fdrive/db";
import { startPostgres } from "@fdrive/testkit";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import type { Pool } from "pg";
import tar from "tar-stream";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  AttachmentStore,
  assertCoverage,
  BackupEngine,
  BackupOperations,
  BackupStore,
  bytesStream,
  captureSnapshot,
  DURABLE_TABLES,
  destinationKey,
  digest,
  discoverBackups,
  extractAttachment,
  fetchBackup,
  inspectArchive,
  legacyOcrMappings,
  limitBytes,
  localBlobs,
  nextSchedule,
  OMITTED_TABLES,
  quoteIdentifier,
  quoteTable,
  readBounded,
  readCompletion,
  restoreArchive,
  retentionKeep,
  verifyDelivery,
  withBackupWriter,
} from "../src/index.js";
import type { BackupSource, SnapshotHeader, SnapshotManifest } from "../src/types.js";
import { memoryDestination, required, secrets } from "./helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat), statfs: vi.fn(actual.statfs) };
});
let container: Awaited<ReturnType<typeof startPostgres>>;
let control: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>;
let store: BackupStore;
let directory: string;
let key: string;
let recipient: string;
const databases: ReturnType<typeof createDb>[] = [];
let sequence = 0;
async function fresh() {
  const name = `backup_test_${sequence++}`;
  await control.pool.query(`create database ${name}`);
  const url = new URL(container.connectionString);
  url.pathname = `/${name}`;
  const database = createDb(url.toString());
  databases.push(database);
  await migrate(database.db);
  return database;
}
const policy = {
  frequency: "daily" as const,
  timezone: "Europe/Stockholm",
  hour: 3,
  daily: 7,
  weekly: 4,
  monthly: 12,
};
function source(overrides: Partial<BackupSource> = {}): BackupSource {
  return {
    pool: db.pool,
    masterKey: randomBytes(32).toString("base64"),
    environment: { release: "test" },
    blobs: async () => ({ sources: [], coverage: [] }),
    ...overrides,
  };
}
async function snapshot(overrides: Partial<BackupSource> = {}, metadataOnly = false) {
  const config = await store.configuration();
  const id = randomUUID();
  const output = join(directory, `${id}.age`);
  const result = await captureSnapshot(source(overrides), {
    id,
    installationId: config.installation_id,
    recipient,
    output,
    metadataOnly,
  });
  return { ...result, id, output };
}
function engine(transport = memoryDestination(), now?: () => Date) {
  return {
    transport,
    engine: new BackupEngine({
      store,
      source: source(),
      directory: join(directory, `archives-${randomUUID()}`),
      destination: async () => transport.destination,
      ...(now ? { now } : {}),
    }),
  };
}
async function confirmed(engine: BackupEngine) {
  const challenge = await engine.challenge(recipient);
  const decrypt = new Decrypter();
  decrypt.addIdentity(key);
  await engine.confirm(await decrypt.decrypt(Buffer.from(challenge, "base64"), "text"));
}
beforeAll(async () => {
  container = await startPostgres();
  control = createDb(container.connectionString);
  directory = await mkdtemp(join(tmpdir(), "backup-unit-"));
  key = await generateIdentity();
  recipient = await identityToRecipient(key);
}, 180_000);
beforeEach(async () => {
  db = await fresh();
  store = new BackupStore(db.pool);
}, 180_000);
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
  await control?.close();
  await container?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 180_000);

it("roundtrips all registered tables, configuration ZIPs and exact bigint values", async () => {
  await db.pool.query(
    "insert into app.system_events(id,subsystem,level,message,data) values(9007199254740993,'general','info','Durable activity',$1)",
    [JSON.stringify({ nested: ["x", null] })],
  );
  const attachments = new AttachmentStore(store, join(directory, randomUUID()), secrets);
  const id = await attachments.upload(
    {
      label: "Router",
      filename: "router.zip",
      sourceDate: "2026-09-01T00:00:00Z",
      notes: "External configuration",
    },
    bytesStream(Buffer.from("opaque ZIP bytes")),
  );
  const rows = await store.attachments();
  expect(await store.attachment(id)).not.toBeNull();
  const file = await snapshot({
    blobs: async () => ({ sources: rows.map((row) => attachments.source(row)), coverage: [] }),
  });
  const inspection = await inspectArchive(file.output, key);
  expect(Object.keys(inspection.manifest.tables)).toHaveLength(DURABLE_TABLES.length);
  const target = await fresh();
  const stage = join(directory, randomUUID());
  await mkdir(stage);
  await restoreArchive({
    pool: target.pool,
    file: file.output,
    identity: key,
    stateDirectory: stage,
    secrets,
    reseal: (bytes) => bytes,
  });
  expect(
    (await target.pool.query("select id::text,message from app.system_events")).rows[0],
  ).toEqual({ id: "9007199254740993", message: "Durable activity" });
  const state = (
    await target.pool.query("select value from app.settings where key='backup.restore.v1'")
  ).rows[0].value;
  const restoredStore = new BackupStore(target.pool);
  const restored = new AttachmentStore(
    restoredStore,
    join(state.stateDirectory, "attachments"),
    secrets,
  );
  expect(
    (
      await readBounded(await restored.download(required((await restoredStore.attachments())[0])))
    ).toString(),
  ).toBe("opaque ZIP bytes");
  const record = required(inspection.manifest.blobs[0]);
  const output = join(directory, `${randomUUID()}.zip`);
  await extractAttachment(file.output, key, record, output);
  expect(await readFile(output, "utf8")).toBe("opaque ZIP bytes");
  await expect(extractAttachment(file.output, key, record, output)).rejects.toThrow();
  expect(await readFile(output, "utf8")).toBe("opaque ZIP bytes");
  await expect(
    restoreArchive({
      pool: target.pool,
      file: file.output,
      identity: key,
      stateDirectory: stage,
      secrets,
      reseal: (bytes) => bytes,
    }),
  ).rejects.toThrow("not empty");
});
it("rejects wrong keys, damaged ciphertext, unknown tables and missing required schema", async () => {
  const file = await snapshot();
  await expect(inspectArchive(file.output, await generateIdentity())).rejects.toThrow();
  const broken = join(directory, randomUUID());
  const bytes = await readFile(file.output);
  bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 1;
  await writeFile(broken, bytes);
  await expect(inspectArchive(broken, key)).rejects.toThrow();
  await db.pool.query("create table app.unclassified(value text)");
  await expect(snapshot()).rejects.toThrow("coverage mismatch");
  expect(() =>
    assertCoverage([...DURABLE_TABLES, ...Object.keys(OMITTED_TABLES), "app.unknown"]),
  ).toThrow("unknown=app.unknown");
  expect(() => assertCoverage([])).toThrow("missing=");
  expect(quoteIdentifier("safe_name")).toBe('"safe_name"');
  expect(() => quoteIdentifier('x";drop table')).toThrow();
  expect(() => quoteTable("app.unknown")).toThrow();
});
it("keeps partial metadata snapshots honest and rejects changed source files", async () => {
  const root = join(directory, randomUUID());
  await mkdir(root);
  await writeFile(join(root, "bytes"), "123");
  const selected = await localBlobs(root, "desktop");
  await appendFile(join(root, "bytes"), "4");
  await expect(required(selected[0]).open()).rejects.toThrow("changed");
  const metadata = await snapshot(
    {
      blobs: async () => ({
        sources: await localBlobs(root, "desktop"),
        coverage: ["Office keys unavailable"],
      }),
    },
    true,
  );
  const result = await inspectArchive(metadata.output, key);
  expect(result.manifest.blobs).toHaveLength(0);
  expect(result.manifest.coverage).toHaveLength(2);
  const regular = await snapshot({
    blobs: async () => ({ sources: await localBlobs(root, "desktop"), coverage: [] }),
  });
  expect((await inspectArchive(regular.output, key)).manifest.blobs[0]?.size).toBe(4);
  await symlink("bytes", join(root, "link"));
  await expect(localBlobs(root, "desktop")).rejects.toThrow("Symbolic links");
});
it("streams bounded entries and stable prefixes of diagnostic logs", async () => {
  expect(await digest(bytesStream(Buffer.from("abc")))).toEqual({
    bytes: 3,
    sha256: createHash("sha256").update("abc").digest("hex"),
  });
  await expect(readBounded(bytesStream(Buffer.from("abc")), 2)).rejects.toThrow("exceeds");
  await expect(readBounded(bytesStream(Buffer.from("abc")).pipe(limitBytes(2)))).rejects.toThrow(
    "limit",
  );
  const root = join(directory, randomUUID());
  await mkdir(root);
  await writeFile(join(root, "service.log"), "before\n");
  await writeFile(join(root, "empty"), "");
  const files = await localBlobs(root, "logs");
  await appendFile(join(root, "service.log"), "after\n");
  for (const file of files) expect((await readBounded(await file.open())).length).toBe(file.size);
  await expect(localBlobs(root, "logs", 0)).rejects.toThrow("Too many");
});
it("publishes immutable configuration versions and preserves old bytes on failed replacement", async () => {
  const attachments = new AttachmentStore(store, join(directory, randomUUID()), secrets, 10, 20);
  const metadata = { label: "Config", filename: "config.zip", sourceDate: null, notes: "" };
  const id = await attachments.upload(metadata, bytesStream(Buffer.from("first")));
  const first = await store.attachment(id);
  await expect(attachments.upload(metadata, bytesStream(Buffer.alloc(11)), id)).rejects.toThrow(
    "quota",
  );
  expect((await store.attachment(id))?.version_id).toBe(first?.version_id);
  await expect(
    attachments.upload({ ...metadata, filename: "../config.zip" }, bytesStream(Buffer.from("bad"))),
  ).rejects.toThrow("simple filename");
  await expect(attachments.upload(metadata, bytesStream(Buffer.alloc(0)))).rejects.toThrow("empty");
  await attachments.upload(metadata, bytesStream(Buffer.from("second")), id);
  expect((await store.attachment(id))?.version_id).not.toBe(first?.version_id);
  expect((await readBounded(await attachments.download(required(first)))).toString()).toBe("first");
  await attachments.collect();
  expect(await readdir(attachments.directory)).toHaveLength(1);
  await store.deleteAttachment(id);
  await attachments.collect();
  expect(await store.attachment(id)).toBeNull();
  expect(() => attachments.path("../bad")).toThrow();
});
it("checks key possession, owner authority, transactional queues and schedule validation", async () => {
  const { engine: worker } = engine();
  await expect(store.queue(null, { destinationIds: [], metadataOnly: false })).rejects.toThrow(
    "Confirm",
  );
  await expect(worker.confirm("wrong")).rejects.toThrow("expired");
  await expect(store.setSchedule(policy, new Date())).rejects.toThrow("Confirm");
  await confirmed(worker);
  const account = randomUUID();
  expect(await store.owner(account)).toBe(false);
  await db.pool.query("insert into app.settings(key,value) values('setup.owner.v1',$1)", [
    JSON.stringify({ state: "complete", accountId: account }),
  ]);
  expect(await store.owner(account)).toBe(true);
  await expect(
    store.queue(account, { destinationIds: [randomUUID()], metadataOnly: false }),
  ).rejects.toThrow("not enabled");
  expect(await store.runs()).toHaveLength(0);
  await store.setSchedule(policy, new Date("2026-09-14T10:00:00Z"));
  expect((await store.configuration()).next_run_at?.toISOString()).toBe("2026-09-15T01:00:00.000Z");
  expect(await store.queue(account, { destinationIds: [], metadataOnly: false }, "slot")).not.toBe(
    "",
  );
  expect(await store.queue(account, { destinationIds: [], metadataOnly: false }, "slot")).toBe("");
});
it("captures, verifies, discovers and downloads one immutable archive to independent destinations", async () => {
  const { engine: worker, transport } = engine();
  await confirmed(worker);
  const destination = {
    id: randomUUID(),
    revision: randomUUID(),
    name: "Bucket",
    type: "s3",
    config: {},
    secret: Buffer.from("test"),
    enabled: false,
    tested_at: null,
  };
  await worker.testDestination(destination);
  expect(transport.objects.size).toBe(0);
  expect((await store.destination(destination.id))?.enabled).toBe(true);
  const id = await worker.queue(randomUUID(), {
    destinationIds: [destination.id],
    metadataOnly: false,
  });
  await worker.tick();
  const run = await store.run(id);
  expect(run?.state).toBe("complete");
  expect((await store.deliveries(id))[0]?.state).toBe("complete");
  await worker.verify(id);
  expect((await store.run(id))?.verified_at).not.toBeNull();
  const catalog = await discoverBackups(transport.destination);
  expect(catalog[0]?.id).toBe(id);
  expect(await readCompletion(transport.destination, id)).toEqual(catalog[0]);
  const downloaded = join(directory, randomUUID());
  await fetchBackup(transport.destination, id, downloaded);
  expect(await readFile(downloaded)).toEqual(await readFile(worker.artifact(id)));
  const file = worker.artifact(id);
  const initialVersion = (await transport.destination.information(`${id}.fdrive.age`))?.versionId;
  await verifyDelivery(transport.destination, `${id}.fdrive.age`, file);
  expect((await transport.destination.information(`${id}.fdrive.age`))?.versionId).toBe(
    initialVersion,
  );
  await db.pool.query("update app.backup_runs set pinned=true where id=$1", [id]);
  await expect(worker.remove(id)).rejects.toThrow("pinned");
  await db.pool.query("update app.backup_runs set pinned=false where id=$1", [id]);
  transport.lock(true);
  await expect(worker.remove(id)).rejects.toThrow("Object Lock");
  transport.lock(false);
  await worker.remove(id);
  expect((await store.run(id))?.artifact).toBeNull();
  expect(transport.objects.size).toBe(0);
});
it("retries the retained artifact after a destination fails without recapturing metadata", async () => {
  const { engine: worker, transport } = engine();
  await confirmed(worker);
  const destination = {
    id: randomUUID(),
    revision: randomUUID(),
    name: "Remote",
    type: "provider",
    config: {},
    secret: Buffer.alloc(0),
    enabled: true,
    tested_at: null,
  };
  await store.saveDestination(destination);
  transport.offline(true);
  const id = await worker.queue(randomUUID(), {
    destinationIds: [destination.id],
    metadataOnly: false,
  });
  await worker.tick();
  expect((await store.run(id))?.state).toBe("partial");
  const sha = (await store.run(id))?.sha256;
  transport.offline(false);
  await store.setRun(id, "queued");
  await worker.tick();
  expect((await store.run(id))?.state).toBe("complete");
  expect((await store.run(id))?.sha256).toBe(sha);
  const object = required(transport.objects.get(`${id}.fdrive.age`));
  object.bytes = Buffer.from("corrupt");
  await expect(worker.verify(id)).rejects.toThrow("integrity");
  await expect(store.deleteDestination(destination.id)).rejects.toThrow("retained backups");
  await db.pool.query("delete from app.backup_destinations where id=$1", [destination.id]);
  await expect(worker.verify(id)).rejects.toThrow("Destination binding changed");
  await expect(worker.remove(id)).rejects.toThrow("Destination changed");
});
it("coordinates blob writers with capture using real PostgreSQL advisory locks", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing = false;
  const writer = withBackupWriter(db.pool, async () => {
    writing = true;
    await hold;
    return "done";
  });
  await vi.waitFor(() => expect(writing).toBe(true));
  let captured = false;
  const run = snapshot({
    blobs: async () => {
      captured = true;
      return { sources: [], coverage: [] };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(captured).toBe(false);
  release();
  expect(await writer).toBe("done");
  await run;
  expect(captured).toBe(true);
  await expect(
    withBackupWriter(db.pool, async () => {
      throw Error("writer failed");
    }),
  ).rejects.toThrow("writer failed");
});
it("handles DST, downtime and union retention without deleting pins or the last snapshot", () => {
  expect(nextSchedule({ ...policy, frequency: "manual" }, new Date())).toBeNull();
  expect(
    nextSchedule({ ...policy, hour: 2 }, new Date("2026-03-28T12:00:00Z"))?.toISOString(),
  ).toBe("2026-03-29T01:00:00.000Z");
  expect(
    nextSchedule(
      { ...policy, frequency: "hourly" },
      new Date("2026-10-25T00:00:00Z"),
    )?.toISOString(),
  ).toBe("2026-10-25T02:00:00.000Z");
  expect(
    nextSchedule(
      { ...policy, frequency: "weekly" },
      new Date("2026-09-14T12:00:00Z"),
    )?.toISOString(),
  ).toBe("2026-09-20T01:00:00.000Z");
  expect(
    [
      ...retentionKeep(
        [
          { id: "new", createdAt: "2026-09-14T10:00:00Z", pinned: false },
          { id: "old", createdAt: "2025-01-01T10:00:00Z", pinned: true },
        ],
        { ...policy, daily: 1, weekly: 0, monthly: 0 },
      ),
    ].sort(),
  ).toEqual(["new", "old"]);
  expect(retentionKeep([], policy).size).toBe(0);
  expect(destinationKey("/safe/", "one.age")).toBe("safe/one.age");
  expect(() => destinationKey("../bad", "file")).toThrow();
  expect(() => destinationKey("safe", "../bad")).toThrow();
});
it("runs one scheduled catch-up, honors destination policies, and expires local spool without touching pins", async () => {
  const instant = new Date();
  const { engine: worker, transport } = engine(undefined, () => instant);
  await confirmed(worker);
  const destination = {
    id: randomUUID(),
    revision: randomUUID(),
    name: "Offsite",
    type: "s3",
    config: {},
    secret: Buffer.alloc(0),
    enabled: true,
    tested_at: null,
  };
  await store.saveDestination(destination);
  await store.setSchedule(policy, new Date("2026-09-01Z"));
  await worker.tick();
  expect(await store.runs()).toHaveLength(1);
  await worker.tick();
  expect(await store.runs()).toHaveLength(1);
  await store.destinationSchedule(
    destination.id,
    { ...policy, frequency: "hourly" },
    new Date("2026-09-02Z"),
  );
  await worker.tick();
  expect(await store.runs()).toHaveLength(2);
  await store.destinationSchedule(destination.id, null, instant);
  expect((await store.destination(destination.id))?.config.schedule).toBeNull();
  const run = required((await store.runs())[0]);
  await db.pool.query(
    "update app.backup_runs set created_at='2026-09-01',pinned=true where id=$1",
    [run.id],
  );
  await worker.cleanSpool();
  expect((await store.run(run.id))?.artifact).not.toBeNull();
  await db.pool.query("update app.backup_runs set pinned=false where id=$1", [run.id]);
  await worker.cleanSpool();
  expect((await store.run(run.id))?.artifact).toBeNull();
  expect(transport.objects.has(`${run.id}.fdrive.age`)).toBe(true);
  await worker.verify(run.id);
  await expect(store.deleteDestination(destination.id)).rejects.toThrow("retained backups");
  await worker.remove(run.id);
  for (const other of await store.runs()) await worker.remove(other.id);
  await store.deleteDestination(destination.id);
  await expect(worker.verify(run.id)).rejects.toThrow("No retained archive");
});
it("keeps a successful snapshot successful when retention is blocked", async () => {
  const { engine: worker } = engine();
  await confirmed(worker);
  const prune = vi.spyOn(worker, "prune").mockRejectedValue(Error("retention locked"));
  const id = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
  await worker.tick();
  expect((await store.run(id))?.state).toBe("complete");
  expect(prune).toHaveBeenCalled();
  const event = (
    await db.pool.query("select message from app.system_events order by id desc limit 1")
  ).rows[0];
  expect(event.message).toContain("retention is blocked");
  await db.pool.query("update app.backup_runs set verification_requested=true where id=$1", [id]);
  await worker.tick();
  expect((await store.run(id))?.verification_requested).toBe(false);
  await writeFile(worker.artifact(id), "damaged");
  await db.pool.query("update app.backup_runs set verification_requested=true where id=$1", [id]);
  await worker.tick();
  expect((await store.run(id))?.verification_error).toContain("failed");
});
it("recovers abandoned work, handles changed bindings and pauses restored installations", async () => {
  const { engine: worker } = engine();
  await confirmed(worker);
  const id = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
  await store.setRun(id, "capturing");
  await worker.tick();
  expect((await store.run(id))?.state).toBe("failed");
  const destination = {
    id: randomUUID(),
    revision: randomUUID(),
    name: "Old destination",
    type: "s3",
    config: {},
    secret: Buffer.alloc(0),
    enabled: true,
    tested_at: null,
  };
  await store.saveDestination(destination);
  const queued = await worker.queue(randomUUID(), {
    destinationIds: [destination.id],
    metadataOnly: false,
  });
  await expect(store.saveDestination({ ...destination, revision: randomUUID() })).rejects.toThrow(
    "Retained backups",
  );
  await db.pool.query("update app.backup_destinations set revision=$2 where id=$1", [
    destination.id,
    randomUUID(),
  ]);
  await worker.tick();
  expect((await store.run(queued))?.state).toBe("partial");
  await store.setRun(queued, "transferring");
  await worker.tick();
  expect((await store.run(queued))?.state).toBe("partial");
  await db.pool.query("update app.backup_configuration set restored=true");
  await expect(store.queue(null, { destinationIds: [], metadataOnly: false })).rejects.toThrow();
  await worker.tick();
  expect(() => worker.artifact("../../bad")).toThrow();
  await expect(worker.verify(randomUUID())).rejects.toThrow("Choose");
  await expect(worker.remove(randomUUID())).rejects.toThrow("running");
});
it("fails capture safely and releases ownership when a source changes or cancellation is requested", async () => {
  const backup = source({
    blobs: async () => ({
      sources: [
        {
          kind: "desktop",
          path: "payload",
          size: 3,
          open: async () => bytesStream(Buffer.from("larger")),
        },
      ],
      coverage: [],
    }),
  });
  const config = await store.configuration();
  const output = join(directory, randomUUID());
  await expect(
    captureSnapshot(backup, {
      id: randomUUID(),
      installationId: config.installation_id,
      recipient,
      output,
    }),
  ).rejects.toThrow();
  expect(await readdir(directory)).not.toContain(`${output}.partial`);
  await expect(
    snapshot({
      blobs: async () => ({
        sources: [
          {
            kind: "ocr",
            path: "old",
            size: 100,
            open: async () => bytesStream(Buffer.from("short")),
          },
        ],
        coverage: [],
      }),
    }),
  ).rejects.toThrow("truncated");
  const { engine: worker } = engine();
  await confirmed(worker);
  const id = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
  vi.spyOn(worker.options.source, "blobs").mockRejectedValue(Error("source unavailable"));
  await worker.tick();
  expect((await store.run(id))?.state).toBe("failed");
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    captureSnapshot(source(), {
      id: randomUUID(),
      installationId: config.installation_id,
      recipient,
      output: join(directory, randomUUID()),
      signal: aborted.signal,
    }),
  ).rejects.toThrow();
});
it("refuses simultaneous workers and starts and stops idempotently", async () => {
  const { engine: worker } = engine();
  await confirmed(worker);
  const lock = await db.pool.connect();
  await lock.query("select pg_advisory_lock(736591205)");
  await worker.tick();
  await lock.query("select pg_advisory_unlock(736591205)");
  lock.release();
  const tick = vi.spyOn(worker, "tick").mockResolvedValue();
  worker.start();
  worker.start();
  await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
  await worker.stop();
  tick.mockRejectedValue(Error("database down"));
  worker.start();
  await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(2));
  await worker.stop();
});

async function archive(
  entries: { name: string; bytes: Buffer; type?: "file" | "symlink"; linkname?: string }[],
): Promise<string> {
  const pack = tar.pack();
  for (const entry of entries)
    pack.entry(
      {
        name: entry.name,
        type: entry.type ?? "file",
        size: entry.bytes.length,
        ...(entry.linkname ? { linkname: entry.linkname } : {}),
      },
      entry.bytes,
    );
  pack.finalize();
  const encrypt = new Encrypter();
  encrypt.addRecipient(recipient);
  const bytes = await readBounded(
    Readable.fromWeb(
      await encrypt.encrypt(Readable.toWeb(pack.pipe(createGzip())) as ReadableStream<Uint8Array>),
    ),
    20 * 1024 * 1024,
  );
  const path = join(directory, randomUUID());
  await writeFile(path, bytes);
  return path;
}
function emptyManifest(header: SnapshotHeader): SnapshotManifest {
  return {
    format: 1,
    id: header.id,
    tables: Object.fromEntries(
      DURABLE_TABLES.map((table) => [
        table,
        { rows: 0, sha256: createHash("sha256").digest("hex") },
      ]),
    ),
    blobs: [],
    coverage: [],
  };
}
const jsonEntry = (name: string, value: unknown) => ({
  name,
  bytes: Buffer.from(JSON.stringify(value)),
});
it("rejects untrusted archive structure before restoring any database rows or files", async () => {
  const header = (await inspectArchive((await snapshot()).output, key)).header;
  const manifest = emptyManifest(header);
  const head = jsonEntry("header.json", header),
    footer = jsonEntry("manifest.json", manifest);
  const invalid = [
    [footer],
    [head, head, footer],
    [jsonEntry("header.json", { ...header, fingerprint: "0".repeat(64) }), footer],
    [head, { name: "../escape", bytes: Buffer.from("outside") }, footer],
    [
      head,
      { name: "blobs/0", bytes: Buffer.alloc(0), type: "symlink" as const, linkname: "/outside" },
      footer,
    ],
    [head, footer, footer],
    [head],
    [head, jsonEntry("manifest.json", { ...manifest, id: randomUUID() })],
    [head, jsonEntry("manifest.json", { ...manifest, tables: {} })],
    [head, jsonEntry("rows/app.accounts/1.json", []), footer],
    [head, jsonEntry("rows/app.accounts/0.json", []), footer],
    [head, { name: "blobs/0", bytes: Buffer.from("data") }, footer],
    [
      head,
      { name: "blobs/0", bytes: Buffer.from("data") },
      { name: "blobs/0", bytes: Buffer.from("data") },
      footer,
    ],
    [
      head,
      { name: "blobs/0", bytes: Buffer.from("data") },
      jsonEntry("manifest.json", {
        ...manifest,
        blobs: [
          { entry: "blobs/0", kind: "desktop", path: "payload", size: 4, sha256: "0".repeat(64) },
        ],
      }),
    ],
    [
      head,
      jsonEntry("manifest.json", {
        ...manifest,
        tables: { ...manifest.tables, "app.accounts": { rows: 1, sha256: "0".repeat(64) } },
      }),
    ],
  ];
  for (const entries of invalid)
    await expect(inspectArchive(await archive(entries), key)).rejects.toThrow();
  await expect(inspectArchive(await archive([head, footer]), key, {}, 100)).rejects.toThrow(
    "limit",
  );
  const blob = {
    entry: "blobs/0",
    kind: "remote" as const,
    path: "/.fdrive-desktop/old",
    identityId: randomUUID(),
    size: 4,
    sha256: createHash("sha256").update("data").digest("hex"),
  };
  const valid = await archive([
    head,
    { name: blob.entry, bytes: Buffer.from("data") },
    jsonEntry("manifest.json", { ...manifest, blobs: [blob] }),
  ]);
  await expect(inspectArchive(valid, key, { blob: async () => {} })).rejects.toThrow("consumption");
  const target = await fresh();
  await target.pool.query("alter table app.accounts add column unclassified text");
  await expect(
    restoreArchive({
      pool: target.pool,
      file: valid,
      identity: key,
      stateDirectory: directory,
      secrets,
      reseal: (bytes) => bytes,
    }),
  ).rejects.toThrow("matching database schema");
  const wrongRelease = await fresh();
  await wrongRelease.pool.query("update drizzle.__drizzle_migrations set hash='unknown'");
  await expect(
    restoreArchive({
      pool: wrongRelease.pool,
      file: valid,
      identity: key,
      stateDirectory: directory,
      secrets,
      reseal: (bytes) => bytes,
    }),
  ).rejects.toThrow("same trusted");
  const output = join(directory, randomUUID());
  await expect(
    extractAttachment(valid, key, { ...blob, entry: "blobs/9" }, output),
  ).rejects.toThrow("not found");
  await expect(
    extractAttachment(valid, key, { ...blob, sha256: "0".repeat(64) }, output),
  ).rejects.toThrow("integrity");
});
it("rejects stale or tampered remote catalogs and preserves existing output files", async () => {
  const remote = memoryDestination();
  const id = randomUUID();
  const completion = {
    format: 1,
    installationId: randomUUID(),
    id,
    createdAt: new Date().toISOString(),
    key: `${id}.fdrive.age`,
    bytes: "4",
    sha256: createHash("sha256").update("data").digest("hex"),
    versionId: null,
    coverage: [],
  };
  const put = (value: unknown) =>
    remote.objects.set(`${id}.complete.json`, {
      bytes: Buffer.from(JSON.stringify(value)),
      versionId: "marker",
    });
  put({ ...completion, id: randomUUID() });
  await expect(readCompletion(remote.destination, id)).rejects.toThrow("binding");
  put(completion);
  remote.objects.set("ignored", { bytes: Buffer.from("anything"), versionId: "1" });
  expect(await discoverBackups(remote.destination)).toHaveLength(1);
  const output = join(directory, randomUUID());
  remote.objects.set(completion.key, { bytes: Buffer.from("oops"), versionId: "v1" });
  await expect(fetchBackup(remote.destination, id, output)).rejects.toThrow("checksum");
  put({ ...completion, bytes: "9007199254740993" });
  await expect(fetchBackup(remote.destination, id, output)).rejects.toThrow("limit");
  await writeFile(output, "existing file");
  put(completion);
  await expect(fetchBackup(remote.destination, id, output)).rejects.toThrow();
  expect(await readFile(output, "utf8")).toBe("existing file");
});

it("releases writer clients when acquiring or releasing the checkpoint fails", async () => {
  const release = vi.fn();
  const query = vi.fn().mockRejectedValue(Error("connection lost"));
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  await expect(withBackupWriter(pool, async () => "unused")).rejects.toThrow("connection lost");
  expect(release).toHaveBeenCalledOnce();
  query.mockResolvedValueOnce({}).mockResolvedValueOnce({});
  expect(await withBackupWriter(pool, async () => "written")).toBe("written");
  expect(release).toHaveBeenCalledTimes(2);
});

it("aborts a capture when the checkpoint connection is lost and refuses unreadable database rows", async () => {
  const input = source();
  await expect(
    snapshot({
      ...input,
      blobs: async (client) => {
        client.emit("error", Error("checkpoint lost"));
        return { sources: [], coverage: [] };
      },
    }),
  ).rejects.toThrow();
  await db.pool.query("insert into app.settings(key,value) values('large',$1)", [
    JSON.stringify("x".repeat(4 * 1024 * 1024)),
  ]);
  await expect(snapshot()).rejects.toThrow("row exceeds");
});

it("cancels in-flight capture when its persisted lease is cancelled, replaced or unavailable", async () => {
  for (const failure of ["cancelled", "replaced", "unavailable"]) {
    const input = {
      ...source(),
      blobs: async () => ({
        sources: [
          {
            kind: "desktop" as const,
            path: "stalled",
            size: 1,
            open: async () => new Readable({ read() {} }),
          },
        ],
        coverage: [],
      }),
    };
    const { engine: worker } = engine();
    worker.options.source.blobs = input.blobs;
    await confirmed(worker);
    const id = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const task = worker.tick();
    await vi.waitFor(async () => expect((await store.run(id))?.state).toBe("capturing"));
    const spy = vi.spyOn(store, "run");
    if (failure === "cancelled") await store.setRun(id, "cancelled");
    if (failure === "replaced")
      await db.pool.query("update app.backup_runs set lease_id=$2 where id=$1", [id, randomUUID()]);
    if (failure === "unavailable") spy.mockRejectedValue(Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(1001);
    await task;
    spy.mockRestore();
    vi.useRealTimers();
    expect((await store.run(id))?.state).not.toBe("complete");
    await db.pool.query("update app.backup_runs set state='cancelled' where id=$1", [id]);
  }
});

it("retains the last copy and pins while pruning old verified snapshots and abandoned spool", async () => {
  const { engine: worker } = engine();
  await confirmed(worker);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
    await worker.tick();
    ids.push(id);
  }
  await db.pool.query("update app.backup_runs set created_at='2026-01-01' where id=$1", [ids[0]]);
  await db.pool.query(
    "update app.backup_runs set created_at='2026-01-02',pinned=true where id=$1",
    [ids[1]],
  );
  await worker.prune({ ...policy, daily: 1, weekly: 0, monthly: 0 });
  expect((await store.run(required(ids[0])))?.artifact).toBeNull();
  expect((await store.run(required(ids[1])))?.pinned).toBe(true);
  const partial = join(worker.options.directory, `${randomUUID()}.fdrive.age.partial`);
  await writeFile(partial, "abandoned");
  const { utimes } = await import("node:fs/promises");
  await utimes(partial, new Date(0), new Date(0));
  await worker.cleanSpool();
  await expect(readFile(partial)).rejects.toThrow();
});

it("serializes pins with deletion and never claims a deleted backup was kept", async () => {
  const { engine: worker } = engine();
  await confirmed(worker);
  const id = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
  await worker.tick();
  await store.pin(id, true);
  await expect(worker.remove(id)).rejects.toThrow("pinned");
  await store.pin(id, false);
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = false;
  const removal = store.lockRun(id, async (client) => {
    locked = true;
    await hold;
    await client.query("update app.backup_runs set artifact=null where id=$1", [id]);
  });
  await vi.waitFor(() => expect(locked).toBe(true));
  const pin = store.pin(id, true);
  const refused = expect(pin).rejects.toThrow("No retained copy");
  release();
  await removal;
  await refused;
  expect((await store.run(id))?.pinned).toBe(false);
  await expect(store.pin(randomUUID(), true)).rejects.toThrow("no longer exists");
  await store.pin(id, false);
});

it("ends a stalled run on its deadline and when its worker ownership connection disappears", async () => {
  for (const failure of ["deadline", "connection"]) {
    const { engine: worker } = engine();
    await confirmed(worker);
    worker.options.source.blobs = async () => ({
      sources: [
        {
          kind: "desktop",
          path: "stalled",
          size: 1,
          open: async () => new Readable({ read() {} }),
        },
      ],
      coverage: [],
    });
    if (failure === "deadline") worker.options.maxRunMs = 100;
    const id = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
    const task = worker.tick().then(
      () => null,
      (error) => error,
    );
    if (failure === "connection") {
      await vi.waitFor(async () => expect((await store.run(id))?.state).toBe("capturing"));
      const pid = (
        await db.pool.query<{ pid: number }>(
          "select pid from pg_locks where locktype='advisory' and objid=736591205 and database=(select oid from pg_database where datname=current_database())",
        )
      ).rows[0]?.pid;
      expect(pid).toBeTruthy();
      await db.pool.query("select pg_terminate_backend($1)", [pid]);
    }
    const failureResult = await task;
    if (failure === "connection") expect(failureResult).toBeInstanceOf(Error);
    else expect(failureResult).toBeNull();
    expect((await store.run(id))?.state).toBe("cancelled");
  }
});

it("validates attachment bytes, recovers ordinary quarantine files, and refuses credential and blob reference corruption", async () => {
  const attachments = new AttachmentStore(store, join(directory, "attachments"), secrets);
  await attachments.collect();
  const id = await attachments.upload(
    { label: "Config", filename: "config.zip", sourceDate: null, notes: "" },
    bytesStream(Buffer.from("config")),
  );
  const row = required(await store.attachment(id));
  await expect(readBounded(await attachments.download({ ...row, bytes: "999" }))).rejects.toThrow(
    "integrity",
  );
  await expect(
    readBounded(await attachments.download({ ...row, sha256: "0".repeat(64) })),
  ).rejects.toThrow("integrity");
  const result = await snapshot({
    blobs: async () => ({
      sources: [
        {
          kind: "remote",
          path: "/.fdrive-desktop/payload",
          sourceId: "mount-a",
          identityId: randomUUID(),
          size: 3,
          open: async () => bytesStream(Buffer.from("old")),
        },
      ],
      coverage: [],
    }),
  });
  const target = await fresh();
  await restoreArchive({
    pool: target.pool,
    file: result.output,
    identity: key,
    stateDirectory: directory,
    secrets,
    reseal: (bytes) => bytes,
  });
  const state = (
    await target.pool.query("select value from app.settings where key='backup.restore.v1'")
  ).rows[0].value;
  expect(await readFile(join(state.stateDirectory, "blobs-0"), "utf8")).toBe("old");
  expect(state.blobs[0].sourceId).toBe("mount-a");
  const header = (await inspectArchive(result.output, key)).header;
  const manifest = emptyManifest(header);
  const head = jsonEntry("header.json", header);
  const values = required(header.schema["app.credentials"]).map(() => null);
  const rowEntry = jsonEntry("rows/app.credentials/0.json", values);
  const badCredentials = await archive([
    head,
    rowEntry,
    jsonEntry("manifest.json", {
      ...manifest,
      tables: {
        ...manifest.tables,
        "app.credentials": {
          rows: 1,
          sha256: createHash("sha256").update(rowEntry.bytes).digest("hex"),
        },
      },
    }),
  ]);
  await expect(
    restoreArchive({
      pool: (await fresh()).pool,
      file: badCredentials,
      identity: key,
      stateDirectory: directory,
      secrets,
      reseal: (bytes) => bytes,
    }),
  ).rejects.toThrow("Invalid encrypted credential");
  const blob = {
    entry: "blobs/0",
    kind: "attachment",
    path: randomUUID(),
    size: 3,
    sha256: createHash("sha256").update("zip").digest("hex"),
  };
  const badReference = await archive([
    head,
    { name: "blobs/0", bytes: Buffer.from("zip") },
    jsonEntry("manifest.json", { ...manifest, blobs: [blob] }),
  ]);
  await expect(
    restoreArchive({
      pool: (await fresh()).pool,
      file: badReference,
      identity: key,
      stateDirectory: directory,
      secrets,
      reseal: (bytes) => bytes,
    }),
  ).rejects.toThrow("Attachment reference");
  // Multiple catalog entries exercise ordering independently of filesystem enumeration order.
  const remote = memoryDestination();
  for (const date of ["2026-01-01", "2026-02-01"]) {
    const snapshotId = randomUUID();
    remote.objects.set(`${snapshotId}.complete.json`, {
      versionId: "1",
      bytes: Buffer.from(
        JSON.stringify({
          format: 1,
          installationId: randomUUID(),
          id: snapshotId,
          createdAt: `${date}T00:00:00Z`,
          key: `${snapshotId}.fdrive.age`,
          bytes: "0",
          sha256: "0".repeat(64),
          versionId: null,
          coverage: [],
        }),
      ),
    });
  }
  expect((await discoverBackups(remote.destination))[0]?.createdAt).toContain("2026-02");
});

it("refuses work before exhausting disk space and rejects tampered retained archives on retry", async () => {
  const available = await statfs(directory);
  const full = { ...available, bavail: 0 };
  const attachments = new AttachmentStore(store, join(directory, "attachments"), secrets);
  vi.mocked(statfs).mockResolvedValueOnce(full);
  await expect(
    attachments.upload(
      { label: "Config", filename: "config.zip", sourceDate: null, notes: "" },
      bytesStream(Buffer.from("data")),
    ),
  ).rejects.toThrow("storage is full");
  const snapshotFile = await snapshot();
  const target = await fresh();
  vi.mocked(statfs).mockResolvedValueOnce(full);
  await expect(
    restoreArchive({
      pool: target.pool,
      file: snapshotFile.output,
      identity: key,
      stateDirectory: directory,
      secrets,
      reseal: (bytes) => bytes,
    }),
  ).rejects.toThrow("Insufficient storage");
  const { engine: worker, transport } = engine();
  await confirmed(worker);
  const local = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
  vi.mocked(statfs).mockResolvedValueOnce(full);
  await worker.tick();
  expect((await store.run(local))?.state).toBe("failed");
  const destination = {
    id: randomUUID(),
    revision: randomUUID(),
    name: "Remote",
    type: "s3",
    config: {},
    secret: Buffer.alloc(0),
    enabled: true,
    tested_at: null,
  };
  await store.saveDestination(destination);
  transport.offline(true);
  const id = await worker.queue(randomUUID(), {
    destinationIds: [destination.id],
    metadataOnly: false,
  });
  await worker.tick();
  await writeFile(worker.artifact(id), "altered ciphertext");
  transport.offline(false);
  await store.setRun(id, "queued");
  await worker.tick();
  expect((await store.run(id))?.state).toBe("partial");
  expect(transport.objects.has(`${id}.fdrive.age`)).toBe(false);
  const disabled = await worker.queue(randomUUID(), {
    destinationIds: [destination.id],
    metadataOnly: false,
  });
  await store.saveDestination({ ...destination, enabled: false });
  await worker.tick();
  expect((await store.run(disabled))?.state).toBe("partial");
  await db.pool.query("update app.backup_configuration set confirmed=false");
  await expect(store.destinationSchedule(destination.id, policy, new Date())).rejects.toThrow(
    "Confirm",
  );
});

it("reseals stored credentials and destination secrets while discarding credential token caches", async () => {
  const provider = randomUUID(),
    account = randomUUID(),
    identity = randomUUID(),
    destination = randomUUID();
  await db.pool.query(
    "insert into app.providers(id,type,label,base_url) values($1,'sftpgo','Storage','http://fixture.invalid')",
    [provider],
  );
  await db.pool.query("insert into app.accounts(id) values($1)", [account]);
  await db.pool.query(
    "insert into app.identities(id,account_id,provider_id,external_username) values($1,$2,$3,'owner')",
    [identity, account, provider],
  );
  await db.pool.query(
    "insert into app.credentials(identity_id,ciphertext,key_id,cached_token,cached_token_expires_at) values($1,$2,'master-v1','transient-token',now())",
    [identity, secrets.seal(Buffer.from("storage credential"), identity)],
  );
  await store.saveDestination({
    id: destination,
    revision: randomUUID(),
    name: "Bucket",
    type: "s3",
    config: {},
    secret: Buffer.from(
      secrets.seal(Buffer.from("bucket credential"), `backup-destination:${destination}`),
    ),
    enabled: true,
    tested_at: new Date(),
  });
  const result = await snapshot();
  const target = await fresh();
  const contexts: string[] = [];
  await restoreArchive({
    pool: target.pool,
    file: result.output,
    identity: key,
    stateDirectory: directory,
    secrets,
    reseal: (bytes, context) => {
      contexts.push(context);
      return bytes;
    },
  });
  expect(contexts).toEqual(expect.arrayContaining([identity, `backup-destination:${destination}`]));
  const restored = (await target.pool.query("select * from app.credentials")).rows[0];
  expect(restored.cached_token).toBeNull();
  expect(restored.cached_token_expires_at).toBeNull();
  expect(Buffer.from(secrets.open(restored.ciphertext, identity)).toString()).toBe(
    "storage credential",
  );
  expect((await new BackupStore(target.pool).destination(destination))?.enabled).toBe(false);
});

it("publishes worker-created archives with the shared directory owner's permissions", async () => {
  const root = vi.spyOn(process, "getuid").mockReturnValue(0);
  try {
    const { engine: worker } = engine();
    await confirmed(worker);
    const id = await worker.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
    await worker.tick();
    expect((await store.run(id))?.state).toBe("complete");
    const { stat } = await import("node:fs/promises");
    const file = await stat(worker.artifact(id));
    const parent = await stat(directory);
    expect(file.uid).toBe(parent.uid);
    expect(file.mode & 0o077).toBe(0);
  } finally {
    root.mockRestore();
  }
});

it("refuses captures whose metadata cannot pass the restore format limits", async () => {
  const before = await readdir(directory);
  await expect(snapshot({ environment: { large: "x".repeat(4 * 1024 * 1024) } })).rejects.toThrow(
    "restore limit",
  );
  await expect(snapshot({ masterKey: "invalid" })).rejects.toThrow();
  const blob = {
    kind: "desktop" as const,
    path: "file",
    size: 0,
    open: async () => bytesStream(Buffer.alloc(0)),
  };
  await expect(
    snapshot({
      blobs: async () => ({ sources: Array.from({ length: 100_001 }, () => blob), coverage: [] }),
    }),
  ).rejects.toThrow("inventory exceeds");
  await expect(
    snapshot({
      blobs: async () => ({ sources: [], coverage: Array.from({ length: 1001 }, () => "missing") }),
    }),
  ).rejects.toThrow();
  await expect(
    snapshot({
      blobs: async () => ({ sources: [{ ...blob, path: "x".repeat(8193) }], coverage: [] }),
    }),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual(before);
});

it("never replaces an existing archive and removes its own output after a failed database commit", async () => {
  const config = await store.configuration();
  const output = join(directory, "protected.age");
  await writeFile(output, "existing archive");
  const options = { id: randomUUID(), installationId: config.installation_id, recipient, output };
  await expect(captureSnapshot(source(), options)).rejects.toThrow();
  expect(await readFile(output, "utf8")).toBe("existing archive");
  await rm(output);
  const client = await db.pool.connect();
  const query = client.query.bind(client);
  const broken = new Proxy(client, {
    get(target, property) {
      if (property === "query")
        return (...args: unknown[]) => {
          if (args[0] === "commit") throw Error("commit unavailable");
          return Reflect.apply(query, target, args);
        };
      if (property === "release") return () => {};
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pool = { connect: async () => broken } as unknown as Pool;
  try {
    await expect(captureSnapshot(source({ pool }), options)).rejects.toThrow("commit unavailable");
  } finally {
    client.release();
  }
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("persists worker status, bounded estimates, immutable ZIP inventory and owner rehearsal reports", async () => {
  const estimateSource = source({
    blobs: async () => ({
      sources: [
        {
          kind: "attachment",
          path: "version",
          size: 1024,
          open: async () => bytesStream(Buffer.alloc(1024)),
        },
      ],
      coverage: ["OCR source missing"],
    }),
  });
  const operations = new BackupOperations(store, estimateSource, join(directory, "estimates"));
  expect(await operations.status()).toEqual({
    workerSeenAt: null,
    estimate: null,
    rehearsal: null,
  });
  await operations.estimatePending();
  await operations.heartbeat();
  expect((await operations.status()).workerSeenAt).toBeTruthy();
  const id = await operations.requestEstimate();
  const { engine: runner } = engine();
  await confirmed(runner);
  await store.setSchedule(policy, new Date());
  for (const schedule of [undefined, { ...policy, daily: 2, weekly: 0, monthly: 0 }]) {
    await store.saveDestination({
      id: randomUUID(),
      revision: randomUUID(),
      name: "estimate",
      type: "s3",
      config: { schedule },
      secret: Buffer.alloc(1),
      enabled: true,
      tested_at: new Date(),
    });
  }
  await operations.estimatePending();
  const job = required((await operations.status()).estimate);
  expect(job).toMatchObject({ id, state: "complete", error: null });
  const result = required(job.result);
  expect(BigInt(result.databaseBytes)).toBeGreaterThan(0n);
  expect(result.recoveryBytes).toBe("1024");
  expect(result.coverage).toEqual(["OCR source missing"]);
  expect(BigInt(result.retainedBytes)).toBe(BigInt(result.uncompressedBytes) * 25n);
  expect(BigInt(result.transferAndReadbackBytes)).toBe(BigInt(result.uncompressedBytes) * 4n);
  await operations.estimatePending();
  const config = await store.configuration();
  const snapshotId = await runner.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
  await runner.tick();
  await operations.inventory(snapshotId, ["one", "two"]);
  expect(await operations.inventories([snapshotId, "missing"])).toEqual({
    [snapshotId]: { attachmentVersions: ["one", "two"] },
    missing: { attachmentVersions: [] },
  });
  const report = {
    sourceInstallationId: config.installation_id,
    snapshotId,
    completedAt: new Date().toISOString(),
    migrations: [],
    tableCount: 29,
    blobCount: 0,
    result: "passed" as const,
  };
  for (const invalid of [
    { ...report, sourceInstallationId: randomUUID() },
    { ...report, snapshotId: randomUUID() },
    { ...report, completedAt: new Date(Date.now() + 120_000).toISOString() },
  ])
    await expect(operations.recordRehearsal(invalid)).rejects.toThrow("does not match");
  await operations.recordRehearsal(report);
  expect((await operations.status()).rehearsal).toEqual(report);
  const next = await operations.requestEstimate();
  const failing = new BackupOperations(
    store,
    source({
      blobs: async () => {
        throw Error("source unavailable");
      },
    }),
    directory,
  );
  await failing.estimatePending();
  expect((await failing.status()).estimate).toMatchObject({
    id: next,
    state: "failed",
    result: null,
  });
  await operations.requestEstimate();
  const replaced = new BackupOperations(
    store,
    source({
      blobs: async () => {
        await operations.requestEstimate();
        return { sources: [], coverage: [] };
      },
    }),
    directory,
  );
  await replaced.estimatePending();
  expect((await operations.status()).estimate?.state).toBe("pending");
  const disconnected = new BackupOperations(
    store,
    source({
      pool: {
        connect: async () => ({
          query: async () => {
            throw Error("database unavailable");
          },
          release() {},
        }),
      } as unknown as Pool,
    }),
    directory,
  );
  await disconnected.estimatePending();
  expect((await operations.status()).estimate).toMatchObject({ state: "failed", result: null });
  await operations.requestEstimate();
  const slow = new BackupOperations(
    store,
    source({
      blobs: () =>
        new Promise((resolve) => setTimeout(() => resolve({ sources: [], coverage: [] }), 150)),
    }),
    directory,
    10,
  );
  await slow.estimatePending();
  expect((await operations.status()).estimate).toMatchObject({ state: "failed", result: null });
  await new Promise((resolve) => setTimeout(resolve, 250));
});

it("records a retained test object with its deadline and clears it once deletion works again", async () => {
  const { engine: worker, transport } = engine();
  const destination = {
    id: randomUUID(),
    revision: randomUUID(),
    name: "Locked bucket",
    type: "s3",
    config: {},
    secret: Buffer.from("test"),
    enabled: false,
    tested_at: null,
  };
  transport.lock(true);
  await worker.testDestination(destination);
  let saved = required(await store.destination(destination.id));
  expect(saved.enabled).toBe(true);
  expect(saved.config.retainedProbe).toEqual({
    name: expect.stringMatching(/^probe-/),
    retentionUntil: "2030-01-01T00:00:00.000Z",
  });
  expect(
    (await db.pool.query("select message from app.system_events order by id desc limit 1")).rows[0]
      ?.message,
  ).toBe("Backup destination retains its test object");
  expect(transport.objects.size).toBe(1);
  transport.lock(false);
  await worker.testDestination(saved);
  saved = required(await store.destination(destination.id));
  expect(saved.config).not.toHaveProperty("retainedProbe");
  expect(transport.objects.size).toBe(1);
});

it("removes only settled orphaned archives and stale markers from the spool", async () => {
  const { engine: worker } = engine();
  await confirmed(worker);
  await mkdir(worker.options.directory, { recursive: true });
  const spool = (name: string) => join(worker.options.directory, name);
  const failedId = await store.queue(null, { destinationIds: [], metadataOnly: false });
  await db.pool.query("update app.backup_runs set state='failed' where id=$1", [failedId]);
  const queuedId = await store.queue(null, { destinationIds: [], metadataOnly: false });
  const removed = [
    spool(`${randomUUID()}.fdrive.age`),
    spool(`${failedId}.fdrive.age`),
    spool(`${randomUUID()}-${randomUUID()}.complete.json`),
  ];
  const kept = [spool(`${queuedId}.fdrive.age`), spool("notes.txt")];
  const recent = spool(`${randomUUID()}.fdrive.age`);
  for (const file of [...removed, ...kept, recent]) await writeFile(file, "x");
  for (const file of [...removed, ...kept]) await utimes(file, new Date(0), new Date(0));
  await worker.cleanSpool();
  for (const file of removed) await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  for (const file of [...kept, recent]) expect((await stat(file)).isFile()).toBe(true);
  // A file that disappears between listing and inspection is left alone this pass.
  const vanishing = spool(`${randomUUID()}.fdrive.age`);
  await writeFile(vanishing, "x");
  await utimes(vanishing, new Date(0), new Date(0));
  const realStat = required(vi.mocked(stat).getMockImplementation());
  let vanished = false;
  vi.mocked(stat).mockImplementation(async (path, options) => {
    if (path === vanishing && !vanished) {
      vanished = true;
      throw Object.assign(Error("gone"), { code: "ENOENT" });
    }
    return realStat(path, options as never);
  });
  try {
    await worker.cleanSpool();
    expect((await stat(vanishing)).isFile()).toBe(true);
    await worker.cleanSpool();
    await expect(stat(vanishing)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.mocked(stat).mockImplementation(realStat);
  }
});

it("publishes periodic worker heartbeats and records attachment inventory from engine captures", async () => {
  const { engine: runner } = engine();
  await confirmed(runner);
  runner.options.source.blobs = async () => ({
    sources: [
      {
        kind: "attachment",
        path: "attachments/version-one",
        size: 4,
        open: async () => bytesStream(Buffer.from("zip!")),
      },
      {
        kind: "logs",
        path: "logs/indexer.log",
        size: 3,
        open: async () => bytesStream(Buffer.from("log")),
      },
    ],
    coverage: [],
  });
  const heartbeats: Array<() => void> = [];
  const original = globalThis.setInterval;
  const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
    handler: () => void,
    ms?: number,
  ) => {
    if (ms === 5000) heartbeats.push(handler);
    return original(handler, ms);
  }) as typeof setInterval);
  try {
    const id = await runner.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
    await runner.tick();
    expect((await store.run(id))?.state).toBe("complete");
    expect(heartbeats).toHaveLength(1);
    const before = required((await runner.operations.status()).workerSeenAt);
    await new Promise((resolve) => setTimeout(resolve, 5));
    required(heartbeats[0])();
    await vi.waitFor(async () =>
      expect((await runner.operations.status()).workerSeenAt).not.toBe(before),
    );
    expect(await runner.operations.inventories([id])).toEqual({
      [id]: { attachmentVersions: ["attachments/version-one"] },
    });
  } finally {
    spy.mockRestore();
  }
});

it("reports a fallback that cannot be queued and rechecks spool records under lock", async () => {
  const { engine: runner } = engine();
  await confirmed(runner);
  const destination = {
    id: randomUUID(),
    revision: randomUUID(),
    name: "fallback",
    type: "s3" as const,
    config: {},
    secret: Buffer.alloc(1),
    enabled: true,
    tested_at: new Date(),
  };
  await store.saveDestination(destination);
  const id = await store.queue(
    null,
    { destinationIds: [destination.id], metadataOnly: false },
    "scheduled:fallback",
  );
  await store.saveDestination({ ...destination, enabled: false });
  runner.options.source.blobs = async () => {
    throw Error("Recovery mount disconnected");
  };
  await runner.tick();
  expect((await store.run(id))?.state).toBe("failed");
  expect(await store.runs()).toHaveLength(1);
  expect(
    (await db.pool.query("select message from app.system_events order by id desc limit 1")).rows[0]
      ?.message,
  ).toBe("Partial metadata fallback could not be queued");
  runner.options.source.blobs = async () => ({ sources: [], coverage: [] });
  const kept = await runner.queue(randomUUID(), { destinationIds: [], metadataOnly: false });
  await runner.tick();
  await db.pool.query(
    "update app.backup_runs set created_at='2026-01-01',pinned=true where id=$1",
    [kept],
  );
  const stale = (await store.runs()).map((run) => ({ ...run, pinned: false }));
  const listing = vi.spyOn(store, "runs").mockResolvedValueOnce(stale);
  try {
    await runner.cleanSpool();
  } finally {
    listing.mockRestore();
  }
  expect((await store.run(kept))?.artifact).not.toBeNull();
  await expect(readFile(runner.artifact(kept))).resolves.toBeTruthy();
});

it("creates one scheduled local snapshot and a distinct partial fallback after full capture fails", async () => {
  const { engine: runner } = engine();
  await confirmed(runner);
  await store.setSchedule(policy, new Date(Date.now() - 2 * 86400_000));
  runner.options.source.blobs = async (_client, metadataOnly) => {
    if (!metadataOnly) throw Error("Recovery mount disconnected");
    return { sources: [], coverage: [] };
  };
  await runner.tick();
  let runs = await store.runs();
  expect(runs).toHaveLength(2);
  expect(runs.find((run) => run.request.metadataOnly)).toMatchObject({ state: "queued" });
  expect(runs.find((run) => !run.request.metadataOnly)).toMatchObject({ state: "failed" });
  await runner.tick();
  runs = await store.runs();
  expect(runs).toHaveLength(2);
  expect(runs.find((run) => run.request.metadataOnly)).toMatchObject({ state: "partial" });
  await runner.tick();
  expect(await store.runs()).toHaveLength(2);
});

it("recovers only uniquely matched legacy OCR originals and preserves unresolved mappings explicitly", async () => {
  const root = join(directory, randomUUID());
  await mkdir(join(root, "originals"), { recursive: true });
  await mkdir(join(root, "original-mappings"));
  await db.pool.query("insert into idx.roots(id,name) values(1,'documents')");
  const original = Buffer.from("original PDF bytes");
  const probe = join(root, "originals", "probe");
  await writeFile(probe, original);
  await utimes(probe, 1700000000, 1700000000);
  const time = String((await stat(probe, { bigint: true })).mtimeNs);
  const filename = `${createHash("sha256").update(`documents:folder/report.pdf:${original.length}:${time}`).digest("hex").slice(0, 16)}_report.pdf`;
  const { rename } = await import("node:fs/promises");
  await rename(probe, join(root, "originals", filename));
  // The OCR receipt has the rewritten size, while its timestamp matches the preserved original.
  await db.pool.query(
    "insert into idx.ocr_log(root_id,path,size,mtime_ns,status) values(1,'folder/report.pdf',999,$1,'ok')",
    [time],
  );
  await writeFile(join(root, "originals", "unmatched.pdf"), "orphan");
  await writeFile(join(root, "originals", "known.pdf"), "known");
  await writeFile(join(root, "original-mappings", "known.pdf.json"), "{}");
  await mkdir(join(root, "originals", "nested"));
  await writeFile(join(root, "originals", "nested", "skip"), "nested");
  const client = await db.pool.connect();
  try {
    const local = await localBlobs(root, "ocr");
    const mapped = await legacyOcrMappings(client, root, local);
    expect(mapped.sources).toHaveLength(2);
    expect(mapped.coverage).toEqual([
      "1 legacy OCR original mapping(s) unresolved; bytes are preserved for manual recovery",
    ]);
    const resolved = required(mapped.sources.find((blob) => blob.path.includes(filename)));
    expect(JSON.parse((await readBounded(await resolved.open())).toString())).toMatchObject({
      status: "resolved",
      root: "documents",
      path: "folder/report.pdf",
      original: filename,
      size: original.length,
    });
    const unknown = required(mapped.sources.find((blob) => blob.path.includes("unmatched")));
    expect(JSON.parse((await readBounded(await unknown.open())).toString())).toMatchObject({
      status: "unresolved",
      root: null,
      path: null,
    });
    expect(await readdir(join(root, "original-mappings"))).toEqual(["known.pdf.json"]);
    const truncated = {
      query: async () => ({
        rows: Array.from({ length: 1001 }, () => ({
          root: "documents",
          path: "folder/report.pdf",
          mtime_ns: time,
        })),
      }),
    } as unknown as import("pg").PoolClient;
    expect(
      (
        await legacyOcrMappings(truncated, root, [
          required(local.find((blob) => blob.path.includes(filename))),
        ])
      ).coverage,
    ).toHaveLength(1);
    const one = await legacyOcrMappings(client, root, [
      required(local.find((blob) => blob.path.includes(filename))),
    ]);
    expect(one.coverage).toEqual([]);
  } finally {
    client.release();
  }
});
