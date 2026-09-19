import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { captureSnapshot, inspectArchive, readBounded } from "@fdrive/backup";
import { StorageError, type StorageSession } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { createDb, migrate } from "@fdrive/db";
import { createFakeSftpgoServer } from "@fdrive/sftpgo";
import { SEED_USERS, startPostgres } from "@fdrive/testkit";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { open, seal } from "../auth/crypto.js";
import { type AppConfig, loadConfig } from "../config.js";
import * as registry from "../providers/registry.js";
import { environmentFingerprint, resumeRecovery, runBackupCommand } from "./command.js";
import { createBackupModule, rawBackupStorage } from "./module.js";
import {
  createRecoveryApp,
  recoveryIdentity,
  recoveryPreview,
  restoreOptions,
} from "./recovery.js";

let container: Awaited<ReturnType<typeof startPostgres>>;
let control: ReturnType<typeof createDb>;
let source: ReturnType<typeof createDb>;
let config: AppConfig;
let module: ReturnType<typeof createBackupModule>;
let directory: string;
let key: string;
let recipient: string;
const master = randomBytes(32);
const databases: ReturnType<typeof createDb>[] = [];
const closers: (() => Promise<void>)[] = [];
let count = 0;
let owner: string, identity: string, provider: string;
async function fresh() {
  const name = `backup_api_${count++}`;
  await control.pool.query(`create database ${name}`);
  const url = new URL(container.connectionString);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  databases.push(db);
  await migrate(db.db);
  return { db, url: url.toString() };
}
beforeAll(async () => {
  container = await startPostgres();
  control = createDb(container.connectionString);
  key = await generateIdentity();
  recipient = await identityToRecipient(key);
}, 180_000);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-api-"));
  const created = await fresh();
  source = created.db;
  config = loadConfig({
    DATABASE_URL: created.url,
    FDRIVE_MASTER_KEY: master.toString("base64"),
    FDRIVE_BACKUP_STATE_DIR: join(directory, "state"),
    FDRIVE_SETUP_TOKEN: "host-recovery-token-for-fixtures-only",
  });
  module = createBackupModule(config);
  await module.start();
  owner = randomUUID();
  identity = randomUUID();
  provider = randomUUID();
  await source.pool.query(
    "insert into app.providers(id,type,label,base_url,config) values($1,'sftpgo','Files','http://source.invalid','{}')",
    [provider],
  );
  await source.pool.query("insert into app.accounts(id) values($1)", [owner]);
  await source.pool.query(
    "insert into app.identities(id,account_id,provider_id,external_username) values($1,$2,$3,'alice')",
    [identity, owner, provider],
  );
  await source.pool.query(
    "insert into app.credentials(identity_id,key_id,ciphertext) values($1,'master-v1',$2)",
    [
      identity,
      Buffer.from(
        seal(
          master,
          Buffer.from(JSON.stringify({ username: "alice", password: "alice-password" })),
          identity,
        ),
      ),
    ],
  );
  await source.pool.query("insert into app.settings(key,value) values('setup.owner.v1',$1)", [
    JSON.stringify({ state: "complete", accountId: owner }),
  ]);
  const fake = createFakeSftpgoServer({
    users: [...SEED_USERS],
    folders: [],
    files: { alice: { "/docs/readme": "source document" } },
  });
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
  await module.close();
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  for (const db of databases) await db.close();
  await control.close();
  await container.stop();
});
async function snapshot() {
  await module.attachments.upload(
    {
      label: "Fileserver",
      filename: "server.zip",
      sourceDate: null,
      notes: "Use fileserver import",
    },
    Readable.from([Buffer.from("PK opaque config")]),
  );
  const output = join(directory, `${randomUUID()}.age`);
  await captureSnapshot(module.engine.options.source, {
    id: randomUUID(),
    installationId: (await module.store.configuration()).installation_id,
    recipient,
    output,
  });
  return { file: output, inspection: await inspectArchive(output, key) };
}
async function secretFile(name: string, text: string) {
  const file = join(directory, name);
  await writeFile(file, text, { mode: 0o600 });
  return file;
}

it("inspects and extracts encrypted backups without evaluating database configuration", async () => {
  const { file, inspection } = await snapshot();
  const keyFile = await secretFile("key", `# Recovery kit\n${key}\n`);
  const output: string[] = [];
  const unavailable = () => {
    throw Error("No application environment");
  };
  await runBackupCommand(unavailable, ["inspect", "--file", file, "--key-file", keyFile], (value) =>
    output.push(value),
  );
  expect(output.join()).not.toContain(master.toString("base64"));
  expect(JSON.parse(output[0] ?? "").id).toBe(inspection.header.id);
  const version = inspection.manifest.blobs.find((blob) => blob.kind === "attachment")?.path;
  if (!version) throw Error("Missing attachment");
  const extracted = join(directory, "export.zip");
  await runBackupCommand(
    unavailable,
    [
      "extract",
      "--file",
      file,
      "--key-file",
      keyFile,
      "--attachment",
      version,
      "--output",
      extracted,
    ],
    (value) => output.push(value),
  );
  expect(await readFile(extracted, "utf8")).toBe("PK opaque config");
  await expect(
    runBackupCommand(unavailable, ["extract", "--file", file, "--key-file", keyFile]),
  ).rejects.toThrow("Choose --attachment");
  await expect(runBackupCommand(unavailable, ["inspect"])).rejects.toThrow("Supply --file");
  await chmod(keyFile, 0o644);
  await expect(
    runBackupCommand(unavailable, ["inspect", "--file", file, "--key-file", keyFile]),
  ).rejects.toThrow("private files");
  const link = join(directory, "key-link");
  await symlink(keyFile, link);
  await expect(
    runBackupCommand(unavailable, ["inspect", "--file", file, "--key-file", link]),
  ).rejects.toThrow("private files");
  expect(() => recoveryIdentity("not a private key")).toThrow();
  expect(() => recoveryIdentity(`AGE-SECRET-KEY-${"X".repeat(1001)}`)).toThrow();
  expect(recoveryPreview(inspection)).not.toHaveProperty("environment");
});

it("boots only the isolated recovery API, requires host authorization, and restores into a fresh database", async () => {
  const { file, inspection } = await snapshot();
  const target = await fresh();
  const restoredConfig = {
    ...config,
    databaseUrl: target.url,
    fdriveMasterKey: randomBytes(32).toString("base64"),
    fdriveBackupStateDir: join(directory, "recovered"),
  };
  const app = createRecoveryApp(restoredConfig, new Pool({ connectionString: target.url }));
  closers.push(app.close);
  const headers = {
    "x-fdrive-setup-token": config.fdriveSetupToken ?? "",
    "x-requested-with": "fdrive",
  };
  const request = (
    path: string,
    method = "GET",
    body?: RequestInit["body"],
    extra: Record<string, string> = {},
  ) =>
    app.app.request(`/api/v1/recovery/${path}`, {
      method,
      headers: { ...headers, ...extra },
      ...(body ? { body } : {}),
    });
  expect((await app.app.request("/api/v1/health")).status).toBe(200);
  expect((await app.app.request("/api/v1/files")).status).toBe(503);
  expect(
    (await request("status", "GET", undefined, { "x-fdrive-setup-token": "wrong" })).status,
  ).toBe(401);
  expect((await request("status", "GET", undefined, { "x-requested-with": "" })).status).toBe(403);
  expect((await request("inspect", "POST", JSON.stringify({ key }))).status).toBe(409);
  expect(
    (await request("apply", "POST", JSON.stringify({ snapshotId: inspection.header.id }))).status,
  ).toBe(409);
  expect((await request("archive", "POST")).status).toBe(400);
  expect((await request("archive", "POST", await readFile(file))).status).toBe(201);
  expect((await request("inspect", "POST", JSON.stringify({ key: "invalid" }))).status).toBe(400);
  expect(
    (await request("inspect", "POST", JSON.stringify({ key: await generateIdentity() }))).status,
  ).toBe(202);
  const status = async () =>
    (await (await request("status")).json()) as {
      job: { state: string; error: string | null; preview: unknown };
    };
  await vi.waitFor(async () => expect((await status()).job.state).toBe("uploaded"));
  expect((await status()).job.error).toContain("could not be verified");
  expect((await request("archive", "POST", await readFile(file))).status).toBe(201);
  expect((await request("inspect", "POST", JSON.stringify({ key }))).status).toBe(202);
  await vi.waitFor(async () => expect((await status()).job.state).toBe("ready"));
  expect(JSON.stringify(await status())).not.toContain(key);
  expect(
    (await request("apply", "POST", JSON.stringify({ snapshotId: randomUUID() }))).status,
  ).toBe(400);
  expect(
    (await request("apply", "POST", JSON.stringify({ snapshotId: inspection.header.id }))).status,
  ).toBe(202);
  expect((await request("archive", "POST", "other")).status).toBe(409);
  await vi.waitFor(async () => expect((await status()).job.state).toBe("restored"), {
    timeout: 10_000,
  });
  expect((await target.db.pool.query("select enabled from app.providers")).rows[0].enabled).toBe(
    false,
  );
  expect(
    (await target.db.pool.query("select count(*)::int as count from app.sessions")).rows[0].count,
  ).toBe(0);
  const secret = (await target.db.pool.query("select ciphertext from app.credentials")).rows[0]
    .ciphertext;
  expect(
    Buffer.from(
      open(Buffer.from(restoredConfig.fdriveMasterKey, "base64"), secret, identity),
    ).toString(),
  ).toContain("alice-password");
  const review = {
    snapshotId: inspection.header.id,
    environmentFingerprint: environmentFingerprint(restoredConfig),
    providers: [{ id: provider, baseUrl: "http://source.invalid" }],
    ownerIdentityId: identity,
    credential: { username: "alice", password: "alice-password" },
    oldDeploymentStopped: true,
    pathBindingsReviewed: true,
  };
  await expect(
    resumeRecovery(restoredConfig, { ...review, pathBindingsReviewed: false }),
  ).rejects.toThrow();
  await expect(
    resumeRecovery(restoredConfig, { ...review, environmentFingerprint: "0".repeat(64) }),
  ).rejects.toThrow("environment changed");
  await expect(
    resumeRecovery(restoredConfig, {
      ...review,
      providers: [{ id: provider, baseUrl: "http://other.invalid" }],
    }),
  ).rejects.toThrow("binding changed");
  // A missing saved credential must not bypass the fresh owner challenge.
  await target.db.pool.query("delete from app.credentials where identity_id=$1", [identity]);
  await expect(
    resumeRecovery(restoredConfig, {
      ...review,
      credential: { username: "alice", password: "wrong" },
    }),
  ).rejects.toThrow();
  await resumeRecovery(restoredConfig, review);
  expect((await target.db.pool.query("select enabled from app.providers")).rows[0].enabled).toBe(
    true,
  );
  expect(
    (
      await target.db.pool.query(
        "select count(*)::int as count from app.settings where key='backup.restore.v1'",
      )
    ).rows[0].count,
  ).toBe(0);
  const resumed = createBackupModule(restoredConfig);
  try {
    const rows = await resumed.store.attachments();
    const row = rows[0];
    if (!row) throw Error("Missing restored ZIP");
    expect((await readBounded(await resumed.attachments.download(row))).toString()).toBe(
      "PK opaque config",
    );
  } finally {
    await resumed.close();
  }
  await expect(resumeRecovery(restoredConfig, review)).rejects.toThrow("No matching");
});

it("rehearses a host cutover and rollback: the old pair stays untouched and serves again", async () => {
  const { file, inspection } = await snapshot();
  const keyFile = await secretFile("cutover-key", key);
  const rows = async (pool: Pool) => ({
    events: (await pool.query("select count(*)::int as count from app.system_events")).rows[0]
      .count as number,
    providers: (await pool.query("select id,enabled from app.providers order by id")).rows,
    staged: (
      await pool.query(
        "select count(*)::int as count from app.settings where key='backup.restore.v1'",
      )
    ).rows[0].count as number,
  });
  const before = await rows(source.pool);
  const installation = (await module.store.configuration()).installation_id;
  const target = await fresh();
  const stateDirectory = join(directory, "cutover-state");
  const restoredConfig = {
    ...config,
    databaseUrl: target.url,
    fdriveBackupStateDir: stateDirectory,
    fdriveMasterKey: randomBytes(32).toString("base64"),
  };
  const outputs: string[] = [];
  const cli = (args: string[]) =>
    runBackupCommand(restoredConfig, args, (value) => outputs.push(value));
  // 1. Stage into the new database/state pair; the old pair is not touched.
  await cli([
    "restore",
    "--file",
    file,
    "--key-file",
    keyFile,
    "--snapshot",
    inspection.header.id,
    "--state-dir",
    stateDirectory,
  ]);
  expect(outputs.at(-1)).toContain("All services remain paused");
  expect((await rows(target.db.pool)).providers.every((row) => row.enabled === false)).toBe(true);
  expect(await rows(source.pool)).toEqual(before);
  // 2. Cut over: fingerprint the new environment, review, resume in the new pair only.
  await cli(["environment"]);
  const review = await secretFile(
    "cutover-review.json",
    JSON.stringify({
      snapshotId: inspection.header.id,
      environmentFingerprint: outputs.at(-1),
      providers: [{ id: provider, baseUrl: "http://source.invalid" }],
      ownerIdentityId: identity,
      credential: { username: "alice", password: "alice-password" },
      oldDeploymentStopped: true,
      pathBindingsReviewed: true,
    }),
  );
  await cli(["resume", "--review-file", review]);
  expect(outputs.at(-1)).toContain("Restart API with FDRIVE_RESTORE_MODE=false");
  expect((await rows(target.db.pool)).providers.every((row) => row.enabled === true)).toBe(true);
  // 3. Roll back: the old database, master key and state directory still serve as before.
  expect(await rows(source.pool)).toEqual(before);
  const rolledBack = createBackupModule(config);
  try {
    await rolledBack.start();
    expect(await rolledBack.store.configuration()).toMatchObject({
      installation_id: installation,
      restored: false,
    });
    const row = (await rolledBack.store.attachments())[0];
    if (!row) throw Error("Old installation lost its ZIP");
    expect((await readBounded(await rolledBack.attachments.download(row))).toString()).toBe(
      "PK opaque config",
    );
  } finally {
    await rolledBack.close();
  }
});

it("rehearses into a new installation identity without any provider contact or permission to resume", async () => {
  const { file, inspection } = await snapshot();
  const keyFile = await secretFile("rehearsal-key", key);
  const target = await fresh();
  const restoredConfig = {
    ...config,
    databaseUrl: target.url,
    fdriveBackupStateDir: join(directory, "rehearsal"),
  };
  const outputs: string[] = [];
  const fetch = vi.fn().mockRejectedValue(Error("Rehearsal must not contact providers"));
  vi.stubGlobal("fetch", fetch);
  await runBackupCommand(
    restoredConfig,
    [
      "rehearse",
      "--file",
      file,
      "--key-file",
      keyFile,
      "--snapshot",
      inspection.header.id,
      "--state-dir",
      restoredConfig.fdriveBackupStateDir,
    ],
    (value) => outputs.push(value),
  );
  const report = JSON.parse(outputs[0] ?? "{}");
  expect(report).toMatchObject({
    sourceInstallationId: inspection.header.installationId,
    snapshotId: inspection.header.id,
    result: "passed",
    tableCount: 45,
    blobCount: 1,
  });
  expect(
    (await target.db.pool.query("select installation_id,restored from app.backup_configuration"))
      .rows[0],
  ).toMatchObject({ restored: true });
  expect(
    (await target.db.pool.query("select installation_id from app.backup_configuration")).rows[0]
      .installation_id,
  ).not.toBe(inspection.header.installationId);
  await expect(
    resumeRecovery(restoredConfig, {
      snapshotId: inspection.header.id,
      environmentFingerprint: environmentFingerprint(restoredConfig),
      providers: [{ id: provider, baseUrl: "http://source.invalid" }],
      ownerIdentityId: identity,
      credential: { password: "test" },
      oldDeploymentStopped: true,
      pathBindingsReviewed: true,
    }),
  ).rejects.toThrow("Rehearsal installations cannot resume");
  expect(fetch).not.toHaveBeenCalled();
  expect((await source.pool.query("select enabled from app.providers")).rows[0].enabled).toBe(true);
});

it("expires bootstrap authorization and keeps a restored installation paused without normal services", async () => {
  expect(() => createRecoveryApp({ ...config, fdriveSetupToken: undefined }, source.pool)).toThrow(
    "Recovery requires",
  );
  const freshTarget = await fresh();
  const recovery = createRecoveryApp(config, new Pool({ connectionString: freshTarget.url }));
  closers.push(recovery.close);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.now() + 3_600_001);
  expect(
    (
      await recovery.app.request("/api/v1/recovery/status", {
        headers: {
          "x-fdrive-setup-token": config.fdriveSetupToken ?? "",
          "x-requested-with": "fdrive",
        },
      })
    ).status,
  ).toBe(401);
  vi.useRealTimers();
  const pausedTarget = await fresh();
  const paused = createRecoveryApp(config, new Pool({ connectionString: pausedTarget.url }), true);
  closers.push(paused.close);
  expect((await paused.app.request("/api/v1/health")).status).toBe(200);
  expect((await paused.app.request("/api/v1/recovery/status")).status).toBe(503);
});

it("pins provider backup credentials and keeps reserved ciphertext independently recoverable", async () => {
  const record = await module.destinationRecord({
    type: "provider",
    name: "Fileserver",
    providerId: provider,
    prefix: "/docs",
    credential: { username: "alice", password: "alice-password" },
  });
  expect(record.config.prefix).toContain("/.fdrive-backups/");
  const unattended = await module.destinationRecord({
    type: "provider",
    name: "Without one-time codes",
    providerId: provider,
    prefix: "/docs",
    credential: { username: "alice", password: "alice-password", otp: "123456" },
  });
  expect(
    JSON.parse(
      Buffer.from(
        open(master, unattended.secret, `backup-destination:${unattended.id}`),
      ).toString(),
    ),
  ).toEqual({ username: "alice", password: "alice-password" });
  await module.engine.testDestination(record);
  // The offline CLI reaches the same directory with a provider destination file and no database.
  const listed: string[] = [];
  await runBackupCommand(
    config,
    [
      "list",
      "--destination-file",
      await secretFile(
        "provider-destination.json",
        JSON.stringify({
          type: "sftpgo",
          id: provider,
          baseUrl: "http://source.invalid",
          config: {},
          username: "alice",
          prefix: record.config.prefix,
          credential: { username: "alice", password: "alice-password" },
        }),
      ),
    ],
    (value) => listed.push(value),
  );
  expect(JSON.parse(listed.join(""))).toEqual([]);
  const transport = await module.destination({ ...record, enabled: true });
  const file = await secretFile("payload", "encrypted bytes");
  await transport.put("copy.age", file);
  expect((await readBounded(await transport.get("copy.age"))).toString()).toBe("encrypted bytes");
  await module.destinationRecord({
    type: "provider",
    name: "Same directory",
    providerId: provider,
    prefix: "/docs",
    credential: { username: "alice", password: "alice-password" },
  });
  await source.pool.query(
    "update app.providers set base_url='http://changed.invalid' where id=$1",
    [provider],
  );
  await expect(module.destination(record)).rejects.toThrow("provider changed");
  await expect(
    module.destinationRecord({
      type: "provider",
      name: "Missing",
      providerId: randomUUID(),
      prefix: "/",
      credential: {},
    }),
  ).rejects.toThrow("unavailable");
  const bucket = await module.destinationRecord({
    type: "s3",
    name: "Bucket",
    endpoint: "https://s3.example.invalid",
    region: "test",
    bucket: "private",
    prefix: "backups/",
    pathStyle: true,
    accessKeyId: "test",
    secretAccessKey: "secret",
  });
  expect(bucket.config).not.toHaveProperty("secretAccessKey");
  expect(await module.destination(bucket)).toHaveProperty("put");
  await expect(module.destination({ ...bucket, config: {} })).rejects.toThrow("Invalid bucket");
});

it("records missing source coverage and preserves mount identities and staged recovery inventory", async () => {
  const desktop = join(directory, "desktop");
  await mkdir(desktop);
  await writeFile(join(desktop, "accepted"), "accepted bytes");
  const configured = createBackupModule({
    ...config,
    fdriveDesktopStateDir: desktop,
    fdriveOcrUrl: "http://ocr.invalid",
    fdriveIndexerUrl: "http://indexer.invalid",
    fdriveOfficeUrl: "http://office.invalid",
    fdriveBackupSources: [{ kind: "logs", path: join(directory, "missing") }],
  });
  try {
    await configured.start();
    const client = await source.pool.connect();
    try {
      const result = await configured.engine.options.source.blobs(client);
      expect(result.sources[0]?.sourceId).toHaveLength(64);
      expect(result.coverage.join()).toContain("Required logs source");
      expect(result.coverage.join()).toContain("OCR original storage");
      expect(result.coverage.join()).toContain("Office persistent");
    } finally {
      client.release();
    }
  } finally {
    await configured.close();
  }
});

it("provides an explicit host-only ownership repair and rejects accidental live restore", async () => {
  const output: string[] = [];
  const print = (value: string) => output.push(value);
  await runBackupCommand(config, ["accounts"], print);
  expect(output.join()).toContain(owner);
  await expect(
    runBackupCommand(config, ["claim-owner", "--account", owner], print),
  ).rejects.toThrow("ownership already exists");
  await source.pool.query("delete from app.settings where key='setup.owner.v1'");
  await expect(
    runBackupCommand(config, ["claim-owner", "--account", randomUUID()], print),
  ).rejects.toThrow("no storage identity");
  await runBackupCommand(config, ["claim-owner", "--account", owner], print);
  expect(await module.store.owner(owner)).toBe(true);
  await runBackupCommand(config, ["environment"], print);
  expect(output.at(-1)).toBe(environmentFingerprint(config));
  await expect(runBackupCommand(config, ["resume"], print)).rejects.toThrow("review-file");
  await expect(runBackupCommand(config, ["unknown"], print)).rejects.toThrow("Unknown");
  const { file, inspection } = await snapshot();
  const keyFile = await secretFile("private-key", key);
  await expect(
    runBackupCommand(config, ["restore", "--file", file, "--key-file", keyFile], print),
  ).rejects.toThrow("Inspect first");
  await expect(
    runBackupCommand(
      config,
      [
        "restore",
        "--file",
        file,
        "--key-file",
        keyFile,
        "--snapshot",
        inspection.header.id,
        "--state-dir",
        join(directory, "other"),
      ],
      print,
    ),
  ).rejects.toThrow("new empty database");
  const options = restoreOptions(config, source.pool, file, key, directory);
  const sealed = options.secrets.seal(Buffer.from("test"), "context");
  expect(Buffer.from(options.secrets.open(sealed, "context")).toString()).toBe("test");
  const decrypted = new Decrypter();
  decrypted.addIdentity(key);
  const challenge = await module.engine.challenge(recipient);
  await module.engine.confirm(
    Buffer.from(await decrypted.decrypt(Buffer.from(challenge, "base64"))).toString(),
  );
});

it("refreshes only the pinned storage identity and supports providers without bearer tokens", async () => {
  const real = registry.moduleFor("sftpgo");
  if (!real) throw Error("Provider missing");
  let session!: StorageSession;
  const storage = createMemoryStorage();
  const authenticate = vi.fn(async () => ({
    externalUsername: "alice",
    token: { token: "initial", expiresAt: new Date(Date.now() + 60_000) },
  }));
  const mint = vi.fn(async () => ({ token: "renewed", expiresAt: new Date(Date.now() + 60_000) }));
  const providerModule = {
    ...real,
    authenticate,
    mint,
    createStorage: (_instance: unknown, value: StorageSession) => {
      session = value;
      return storage;
    },
  };
  const instance = { id: provider, baseUrl: "http://source.invalid", config: {} };
  const credential = { password: "secret" };
  expect(await rawBackupStorage(providerModule, instance, credential, "alice")).toBe(storage);
  expect(await session.getCredential()).toEqual(credential);
  expect(await session.getToken()).toBe("initial");
  expect(mint).not.toHaveBeenCalled();
  await session.invalidateToken();
  expect(await session.getToken()).toBe("renewed");
  await expect(rawBackupStorage(providerModule, instance, credential, "bob")).rejects.toThrow(
    "identity changed",
  );
  const { mint: _mint, ...withoutMint } = providerModule;
  await rawBackupStorage(withoutMint, instance, credential);
  await session.invalidateToken();
  expect(await session.getToken()).toBeNull();
  authenticate.mockResolvedValue({
    externalUsername: "alice",
    token: { token: "expired", expiresAt: new Date(0) },
  });
  await rawBackupStorage(providerModule, instance, credential);
  expect(await session.getToken()).toBe("renewed");
});

it("discovers and fetches a completed fileserver copy with no database or application key", async () => {
  const { file, inspection } = await snapshot();
  const record = await module.destinationRecord({
    type: "provider",
    name: "Files",
    providerId: provider,
    prefix: "/docs",
    credential: { username: "alice", password: "alice-password" },
  });
  const destination = await module.destination(record);
  const bytes = await readFile(file);
  const id = inspection.header.id;
  await destination.put(`${id}.fdrive.age`, file);
  const marker = await secretFile(
    "marker.json",
    JSON.stringify({
      format: 1,
      installationId: inspection.header.installationId,
      id,
      createdAt: inspection.header.createdAt,
      key: `${id}.fdrive.age`,
      bytes: String(bytes.length),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      versionId: null,
      coverage: [],
    }),
  );
  await destination.put(`${id}.complete.json`, marker);
  const location = await secretFile(
    "destination.json",
    JSON.stringify({
      type: "sftpgo",
      id: provider,
      baseUrl: "http://source.invalid",
      config: {},
      username: "alice",
      prefix: record.config.prefix,
      credential: { username: "alice", password: "alice-password" },
    }),
  );
  const unavailable = () => {
    throw Error("No application environment");
  };
  const output: string[] = [];
  await expect(runBackupCommand(unavailable, ["list"])).rejects.toThrow("destination JSON");
  await runBackupCommand(unavailable, ["list", "--destination-file", location], (value) =>
    output.push(value),
  );
  expect(JSON.parse(output[0] ?? "")[0].id).toBe(id);
  await expect(
    runBackupCommand(unavailable, ["fetch", "--destination-file", location]),
  ).rejects.toThrow("Supply --snapshot");
  const downloaded = join(directory, "downloaded.age");
  await runBackupCommand(
    unavailable,
    ["fetch", "--destination-file", location, "--snapshot", id, "--output", downloaded],
    (value) => output.push(value),
  );
  expect(await readFile(downloaded)).toEqual(bytes);
  const target = await fresh();
  const restoredConfig = {
    ...config,
    databaseUrl: target.url,
    fdriveBackupStateDir: join(directory, "restored"),
  };
  const keyFile = await secretFile("restore-key", key);
  await runBackupCommand(
    () => restoredConfig,
    [
      "restore",
      "--file",
      downloaded,
      "--key-file",
      keyFile,
      "--snapshot",
      id,
      "--state-dir",
      restoredConfig.fdriveBackupStateDir,
    ],
    (value) => output.push(value),
  );
  const review = await secretFile(
    "review.json",
    JSON.stringify({
      snapshotId: id,
      environmentFingerprint: environmentFingerprint(restoredConfig),
      providers: [{ id: provider, baseUrl: "http://source.invalid" }],
      ownerIdentityId: identity,
      credential: { username: "alice", password: "alice-password" },
      oldDeploymentStopped: true,
      pathBindingsReviewed: true,
    }),
  );
  await runBackupCommand(restoredConfig, ["resume", "--review-file", review], (value) =>
    output.push(value),
  );
  expect(output.at(-1)).toContain("Recovery reviewed");
});

it("captures native recovery bytes, preserves quarantined provenance, and reports unavailable copies", async () => {
  const storage = createMemoryStorage({
    [`/.fdrive-desktop/${identity}/trash/original`]: "recover me",
  });
  const real = registry.moduleFor("sftpgo");
  if (!real) throw Error("Provider missing");
  vi.spyOn(registry, "moduleFor").mockReturnValue({ ...real, createStorage: () => storage });
  await source.pool.query(
    "insert into app.desktop_operations(id,identity_id,account_id,request_hash,request,state,result) values($1,$2,$3,'hash','{}','uncertain',$4)",
    [randomUUID(), identity, owner, JSON.stringify({ remoteAttempt: "accepted" })],
  );
  const client = await source.pool.connect();
  try {
    const blobs = () => module.engine.options.source.blobs(client);
    let result = await blobs();
    expect(result.coverage).toEqual([]);
    expect(result.sources[0]?.identityId).toBe(identity);
    const original = result.sources[0];
    if (!original) throw Error("Missing original");
    expect((await readBounded(await original.open())).toString()).toBe("recover me");
    const staged = join(directory, "quarantine");
    await mkdir(staged);
    await writeFile(join(staged, "blobs-old"), "previous bytes");
    await source.pool.query("insert into app.settings(key,value) values('backup.recovery.v1',$1)", [
      JSON.stringify({
        stateDirectory: staged,
        blobs: [
          {
            kind: "remote",
            entry: "blobs/old",
            path: "/old",
            size: 14,
            identityId: identity,
            sourceId: "source-a",
          },
          { kind: "attachment", entry: "ignored", path: "old", size: 0 },
          { kind: "ocr", entry: "blobs/missing", path: "original", size: 1 },
        ],
      }),
    ]);
    result = await blobs();
    expect(result.sources.find((item) => item.path === "/old")).toMatchObject({
      identityId: identity,
      sourceId: "source-a",
      kind: "remote",
    });
    expect(result.coverage.join()).toContain("Previous recovery file is missing");
    await rm(staged, { recursive: true });
    expect((await blobs()).coverage.join()).toContain("Staged recovery files");
    const list = vi
      .spyOn(storage, "list")
      .mockResolvedValue([
        { path: "/escape", name: "escape", kind: "file", size: 1, ext: "", modifiedAt: new Date() },
      ]);
    expect((await blobs()).coverage.join()).toContain("Native remote recovery is unavailable");
    list.mockImplementation(async (path) => [
      {
        path: `${path}/link`,
        name: "link",
        kind: "symlink",
        size: 0,
        ext: "",
        modifiedAt: new Date(),
      },
    ]);
    expect((await blobs()).coverage.join()).toContain("Native remote recovery is unavailable");
    list.mockImplementation(async (path) => [
      { path: `${path}/dir`, name: "dir", kind: "dir", size: 0, ext: "", modifiedAt: new Date() },
    ]);
    expect((await blobs()).coverage.join()).toContain("Native remote recovery is unavailable");
    list.mockRejectedValue(new StorageError("not_found", "gone"));
    expect((await blobs()).coverage.join()).toContain("Native remote recovery is unavailable");
    await source.pool.query("update app.desktop_operations set result=null");
    expect((await blobs()).coverage.join()).not.toContain("Native remote recovery is unavailable");
    await source.pool.query("delete from app.credentials");
    expect((await blobs()).coverage.join()).toContain("Native remote recovery is unavailable");
  } finally {
    client.release();
  }
});

it("keeps the worker dormant during restore and releases process listeners on shutdown", async () => {
  for (const paused of [true, false]) {
    const previous = process.listeners("SIGTERM");
    const previousInt = process.listenerCount("SIGINT");
    const running = runBackupCommand({ ...config, fdriveRestoreMode: paused }, ["worker"]);
    await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(previous.length + 1));
    const handler = process.listeners("SIGTERM").find((item) => !previous.includes(item));
    if (!handler) throw Error("No stop handler");
    handler("SIGTERM");
    await running;
    expect(process.listenerCount("SIGTERM")).toBe(previous.length);
    expect(process.listenerCount("SIGINT")).toBe(previousInt);
  }
  const { fdriveBackupStateDir: _state, ...disabledConfig } = config;
  await expect(runBackupCommand(disabledConfig, ["worker"])).rejects.toThrow(
    "FDRIVE_BACKUP_STATE_DIR",
  );
  const active = createBackupModule({ ...config, fdriveBackupWorker: true });
  try {
    await active.start();
  } finally {
    await active.close();
  }
});

it("refuses changed namespaces, recursive source mounts, and unavailable retained ZIPs", async () => {
  const real = registry.moduleFor("sftpgo");
  if (!real) throw Error("Provider missing");
  const storage = createMemoryStorage({ "/file": "ordinary" });
  const moduleFor = vi
    .spyOn(registry, "moduleFor")
    .mockReturnValue({ ...real, createStorage: () => storage });
  const input = {
    type: "provider" as const,
    name: "Files",
    providerId: provider,
    prefix: "/file",
    credential: { username: "alice", password: "alice-password" },
  };
  await expect(module.destinationRecord(input)).rejects.toThrow("existing private directory");
  await storage.upload("/.fdrive-backups", new Uint8Array([1]));
  await expect(module.destinationRecord({ ...input, prefix: "/" })).rejects.toThrow(
    "namespace is not a directory",
  );
  await storage.deleteFile("/.fdrive-backups");
  const stat = vi.spyOn(storage, "stat");
  stat.mockImplementation(async (path) => {
    if (path === "/") return { kind: "dir", size: 0, modifiedAt: null, contentType: null };
    throw new StorageError("forbidden", "permission denied");
  });
  await expect(module.destinationRecord({ ...input, prefix: "/" })).rejects.toThrow(
    "permission denied",
  );
  stat.mockRestore();
  const record = await module.destinationRecord({ ...input, prefix: "/" });
  moduleFor.mockReturnValue(null);
  await expect(module.destination(record)).rejects.toThrow("Unsupported backup provider");
  moduleFor.mockReturnValue({ ...real, createStorage: () => storage });
  await storage.deleteDir(String(record.config.prefix));
  await storage.upload(String(record.config.prefix), new Uint8Array([1]));
  await expect(module.destination(record)).rejects.toThrow("existing private backup directory");
  const { inspection } = await snapshot();
  const version = inspection.manifest.blobs.find((blob) => blob.kind === "attachment")?.path;
  if (!version) throw Error("No attachment");
  await rm(module.attachments.path(version));
  const client = await source.pool.connect();
  const configured = createBackupModule({
    ...config,
    fdriveBackupSources: [{ kind: "ocr", path: directory }],
  });
  const alias = join(directory, "alias");
  await symlink(directory, alias);
  const overlap = createBackupModule({
    ...config,
    fdriveBackupSources: [{ kind: "ocr", path: alias }],
    fdriveIndexerUrl: "http://indexer.invalid",
  });
  try {
    expect((await module.engine.options.source.blobs(client)).coverage.join()).toContain(
      "Configuration attachment missing",
    );
    expect((await configured.engine.options.source.blobs(client, true)).coverage.join()).toContain(
      "Configuration attachment missing",
    );
    await expect(configured.engine.options.source.blobs(client)).rejects.toThrow(
      "output cannot be inside",
    );
    const result = await overlap.engine.options.source.blobs(client);
    expect(result.coverage.join()).toContain("Required ocr source is unavailable");
    expect(result.coverage.join()).toContain("Retained indexer logs");
  } finally {
    client.release();
    await configured.close();
    await overlap.close();
  }
});

it("rejects unreviewed ownership and checks every saved identity before resuming", async () => {
  const { file, inspection } = await snapshot();
  const target = await fresh();
  const restoredConfig = {
    ...config,
    databaseUrl: target.url,
    fdriveBackupStateDir: join(directory, "restored"),
  };
  const keyFile = await secretFile("key", key);
  await runBackupCommand(
    restoredConfig,
    [
      "restore",
      "--file",
      file,
      "--key-file",
      keyFile,
      "--snapshot",
      inspection.header.id,
      "--state-dir",
      restoredConfig.fdriveBackupStateDir,
    ],
    () => {},
  );
  const review = {
    snapshotId: inspection.header.id,
    environmentFingerprint: environmentFingerprint(restoredConfig),
    providers: [{ id: provider, baseUrl: "http://source.invalid" }],
    ownerIdentityId: identity,
    credential: { username: "alice", password: "alice-password" },
    oldDeploymentStopped: true,
    pathBindingsReviewed: true,
  };
  await expect(
    resumeRecovery(restoredConfig, { ...review, ownerIdentityId: randomUUID() }),
  ).rejects.toThrow("original installation owner");
  const second = randomUUID();
  await target.db.pool.query(
    "insert into app.identities(id,account_id,provider_id,external_username) values($1,$2,$3,'bob')",
    [second, owner, provider],
  );
  await target.db.pool.query(
    "insert into app.credentials(identity_id,key_id,ciphertext) values($1,'master-v1',$2)",
    [
      second,
      Buffer.from(
        seal(
          master,
          Buffer.from(JSON.stringify({ username: "bob", password: "bob-password" })),
          second,
        ),
      ),
    ],
  );
  const real = registry.moduleFor("sftpgo");
  if (!real) throw Error("Provider missing");
  const lookup = vi.spyOn(registry, "moduleFor").mockReturnValue(null);
  await expect(resumeRecovery(restoredConfig, review)).rejects.toThrow(
    "Unsupported restored provider",
  );
  lookup.mockReturnValue({ ...real, authenticate: async () => ({ externalUsername: "mallory" }) });
  await expect(resumeRecovery(restoredConfig, review)).rejects.toThrow("owner identity mismatch");
  lookup.mockReturnValue({
    ...real,
    authenticate: async (_instance, credential) => ({
      externalUsername: credential.username === "alice" ? "alice" : "mallory",
    }),
  });
  await expect(resumeRecovery(restoredConfig, review)).rejects.toThrow(
    "credential identity mismatch",
  );
  lookup.mockReturnValue(real);
  const { fdriveBackupStateDir: _state, ...missingStorage } = restoredConfig;
  await expect(resumeRecovery(missingStorage, review)).rejects.toThrow(
    "Persistent backup directory",
  );
  const version = (await target.db.pool.query("select version_id from app.backup_attachments"))
    .rows[0].version_id;
  const attachmentTarget = join(
    restoredConfig.fdriveBackupStateDir,
    "attachments",
    `${version}.age`,
  );
  await mkdir(join(restoredConfig.fdriveBackupStateDir, "attachments"), { recursive: true });
  await symlink(keyFile, attachmentTarget);
  await expect(resumeRecovery(restoredConfig, review)).rejects.toThrow("not a regular file");
  await rm(attachmentTarget);
  const savedRestore = (
    await target.db.pool.query("select value from app.settings where key='backup.restore.v1'")
  ).rows[0].value;
  lookup.mockReturnValue({
    ...real,
    authenticate: async (instance, credential, context) => {
      const authenticated = await real.authenticate(instance, credential, context);
      await target.db.pool.query(
        "update app.settings set value=jsonb_set(value,'{snapshotId}',to_jsonb($1::text)) where key='backup.restore.v1'",
        [randomUUID()],
      );
      return authenticated;
    },
  });
  await expect(resumeRecovery(restoredConfig, review)).rejects.toThrow("Restore state changed");
  expect((await target.db.pool.query("select enabled from app.providers")).rows[0].enabled).toBe(
    false,
  );
  await target.db.pool.query("update app.settings set value=$1 where key='backup.restore.v1'", [
    JSON.stringify(savedRestore),
  ]);
  lookup.mockReturnValue(real);
  await resumeRecovery(restoredConfig, review);
  expect((await target.db.pool.query("select enabled from app.providers")).rows[0].enabled).toBe(
    true,
  );
});

it("clears expired recovery secrets and reports failed uploads and nonempty-target imports", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const expiring = createRecoveryApp(config, new Pool({ connectionString: config.databaseUrl }));
  closers.push(expiring.close);
  expect(
    (
      await expiring.app.request("/api/v1/recovery/archive", {
        method: "POST",
        headers: {
          "x-fdrive-setup-token": config.fdriveSetupToken ?? "",
          "x-requested-with": "fdrive",
        },
        body: "pending archive",
      })
    ).status,
  ).toBe(201);
  await vi.advanceTimersByTimeAsync(3_600_001);
  expect(
    (
      await expiring.app.request("/api/v1/recovery/status", {
        headers: {
          "x-fdrive-setup-token": config.fdriveSetupToken ?? "",
          "x-requested-with": "fdrive",
        },
      })
    ).status,
  ).toBe(401);
  vi.useRealTimers();
  const recovery = createRecoveryApp(config, new Pool({ connectionString: config.databaseUrl }));
  closers.push(recovery.close);
  const headers = {
    "x-fdrive-setup-token": config.fdriveSetupToken ?? "",
    "x-requested-with": "fdrive",
  };
  const broken = new ReadableStream({
    start(controller) {
      controller.error(Error("upload disconnected"));
    },
  });
  const request = new Request("http://localhost/api/v1/recovery/archive", {
    method: "POST",
    headers,
    body: broken,
    duplex: "half",
  } as RequestInit);
  expect((await recovery.app.request(request)).status).toBe(400);
  const { file, inspection } = await snapshot();
  await recovery.app.request("/api/v1/recovery/archive", {
    method: "POST",
    headers,
    body: await readFile(file),
  });
  await recovery.app.request("/api/v1/recovery/inspect", {
    method: "POST",
    headers,
    body: JSON.stringify({ key }),
  });
  const status = async () =>
    (await (await recovery.app.request("/api/v1/recovery/status", { headers })).json()) as {
      job: { state: string; error: string };
    };
  await vi.waitFor(async () => expect((await status()).job.state).toBe("ready"));
  await recovery.app.request("/api/v1/recovery/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ snapshotId: inspection.header.id }),
  });
  await vi.waitFor(async () => expect((await status()).job.state).toBe("uploaded"));
  expect((await status()).job.error).toContain("Restore failed");
});

it("reconnects after idle backup database connections are terminated", async () => {
  const expected = await module.store.configuration();
  for (const pool of [module.pool, module.gatePool]) {
    const pid = (await pool.query("select pg_backend_pid() as pid")).rows[0].pid;
    const disconnected = new Promise<void>((resolve) => pool.once("error", () => resolve()));
    await source.pool.query("select pg_terminate_backend($1)", [pid]);
    await disconnected;
    expect((await pool.query("select 1 as ok")).rows[0].ok).toBe(1);
  }
  expect((await module.store.configuration()).installation_id).toBe(expected.installation_id);
});

it("recovers legacy OCR original mappings from a configured OCR mount", async () => {
  const root = join(directory, "ocr-root");
  await mkdir(join(root, "originals"), { recursive: true });
  await writeFile(join(root, "originals", "orphan.pdf"), "legacy original");
  const configured = createBackupModule({
    ...config,
    fdriveBackupSources: [{ kind: "ocr", path: root }],
  });
  const client = await source.pool.connect();
  try {
    const result = await configured.engine.options.source.blobs(client);
    expect(result.sources.filter((blob) => blob.kind === "ocr").length).toBeGreaterThanOrEqual(2);
    expect(result.coverage.join()).toContain("legacy OCR original mapping(s) unresolved");
  } finally {
    client.release();
    await configured.close();
  }
});
