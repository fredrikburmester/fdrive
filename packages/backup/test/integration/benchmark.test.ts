import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDb, migrate } from "@fdrive/db";
import { startPostgres } from "@fdrive/testkit";
import { generateIdentity, identityToRecipient } from "age-encryption";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  BACKUP_GATE,
  BackupStore,
  captureSnapshot,
  localBlobs,
  restoreArchive,
  withBackupWriter,
} from "../../src/index.js";
import { secrets } from "../helpers.js";

/**
 * Publishes measured capture/restore costs for the operator documentation. Numbers are local
 * observations on the test host, so the assertions guard the fixture shapes and the checkpoint
 * contract (docs/BACKUPS.md), never a duration: a writer waits for the capture to publish its
 * archive, and gives up with lock_not_available only after waiting its full 30 seconds.
 */
const MiB = 1024 * 1024;
let container: Awaited<ReturnType<typeof startPostgres>>;
let control: ReturnType<typeof createDb>;
let directory: string;
let identity: string;
let recipient: string;
let sequence = 0;
const databases: ReturnType<typeof createDb>[] = [];
async function fresh() {
  const name = `backup_bench_${sequence++}`;
  await control.pool.query(`create database ${name}`);
  const url = new URL(container.connectionString);
  url.pathname = `/${name}`;
  const database = createDb(url.toString());
  databases.push(database);
  await migrate(database.db);
  return database;
}
async function measure<T>(work: () => Promise<T>) {
  const started = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 50);
  try {
    const result = await work();
    return { result, ms: Math.round(performance.now() - started), peakRssBytes };
  } finally {
    clearInterval(sampler);
  }
}
async function gateHeld(pool: Pool) {
  // A single bigint advisory key shows in pg_locks as classid = high 32 bits, objid = low 32 bits.
  const { rows } = await pool.query<{ held: boolean }>(
    `select exists (select 1 from pg_locks where locktype = 'advisory' and granted
       and mode = 'ExclusiveLock' and classid = ($1::bigint >> 32)::oid
       and objid = ($1::bigint & 4294967295)::oid and objsubid = 1
       and database = (select oid from pg_database where datname = current_database())) as held`,
    [BACKUP_GATE],
  );
  return rows[0]?.held ?? false;
}
/**
 * A cooperating writer that asks for the shared checkpoint lock as soon as the capture holds it
 * exclusively, so its wait is the pause every fdrive-owned recovery writer experiences.
 */
async function probeWriter(pool: Pool, capture: Promise<unknown>, output: string) {
  let settled = false;
  const settle = () => {
    settled = true;
  };
  capture.then(settle, settle);
  while (!settled && !(await gateHeld(pool))) await sleep(5);
  const started = performance.now();
  try {
    const published = await withBackupWriter(pool, async () => existsSync(output));
    return { pauseMs: Math.round(performance.now() - started), gaveUp: false, published };
  } catch (error) {
    if ((error as { code?: unknown }).code !== "55P03") throw error;
    return { pauseMs: Math.round(performance.now() - started), gaveUp: true, published: false };
  }
}
beforeAll(async () => {
  container = await startPostgres();
  control = createDb(container.connectionString);
  directory = await mkdtemp(join(tmpdir(), "fdrive-backup-bench-"));
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
}, 180_000);
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close()));
  await control?.close();
  await container?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 180_000);

it("measures capture, writer pause, spool bytes and fresh restore for small and large fixtures", async () => {
  const report: Record<string, Record<string, number>> = {};
  for (const size of ["small", "large"] as const) {
    const db = await fresh();
    const store = new BackupStore(db.pool);
    const config = await store.configuration();
    const recovery = join(directory, `${size}-recovery`);
    await mkdir(recovery);
    let historyRows = 0;
    let recoveryBytes = 0;
    if (size === "large") {
      await db.pool.query("insert into idx.roots(id,name) values(1,'documents')");
      await db.pool.query(
        "insert into idx.scans(root_id,started_at) select 1,now() - g * interval '1 hour' from generate_series(1,50000) g",
      );
      await db.pool.query(
        "insert into app.system_events(subsystem,level,message,data) select 'general','info','Event '||g,'{}' from generate_series(1,10000) g",
      );
      historyRows = 60_000;
      recoveryBytes = 64 * MiB;
      await pipeline(
        Readable.from(
          (function* () {
            for (let i = 0; i < 64; i++) yield randomBytes(MiB);
          })(),
        ),
        createWriteStream(join(recovery, "large.payload")),
      );
    }
    const output = join(directory, `${size}.fdrive.age`);
    const capturing = measure(() =>
      captureSnapshot(
        {
          pool: db.pool,
          masterKey: randomBytes(32).toString("base64"),
          environment: { release: "benchmark" },
          blobs: async () => ({ sources: await localBlobs(recovery, "office"), coverage: [] }),
        },
        { id: randomUUID(), installationId: config.installation_id, recipient, output },
      ),
    );
    const [capture, writer] = await Promise.all([
      capturing,
      probeWriter(db.pool, capturing, output),
    ]);
    if (writer.gaveUp) {
      // withBackupWriter's lock_timeout: the capture outlasted the writer's whole 30 s wait.
      expect(writer.pauseMs).toBeGreaterThanOrEqual(30_000);
      expect(capture.ms).toBeGreaterThanOrEqual(writer.pauseMs);
    } else expect(writer.published).toBe(true);
    const archiveBytes = (await stat(output)).size;
    const target = await fresh();
    const stage = join(directory, `${size}-restore`);
    await mkdir(stage);
    const restore = await measure(() =>
      restoreArchive({
        pool: target.pool,
        file: output,
        identity,
        stateDirectory: stage,
        secrets,
        reseal: (bytes) => bytes,
      }),
    );
    expect(restore.result.header.id).toBe(capture.result.manifest.id);
    report[size] = {
      historyRows,
      recoveryBytes,
      encryptedSpoolBytes: archiveBytes,
      captureMs: capture.ms,
      captureAndWriterPauseMs: writer.pauseMs,
      writerGaveUp: writer.gaveUp ? 1 : 0,
      capturePeakRssMiB: Math.round(capture.peakRssBytes / MiB),
      freshRestoreMs: restore.ms,
      restorePeakRssMiB: Math.round(restore.peakRssBytes / MiB),
    };
  }
  const evaluation = fileURLToPath(
    new URL("../../../../.fdrive-workflow/evaluation/", import.meta.url),
  );
  await mkdir(evaluation, { recursive: true });
  await writeFile(
    join(evaluation, "backup-benchmark.json"),
    JSON.stringify(
      { measuredAt: new Date().toISOString(), host: process.platform, ...report },
      null,
      2,
    ),
  );
  console.info(`backup benchmark ${JSON.stringify(report)}`);
  expect(report.large?.encryptedSpoolBytes).toBeGreaterThan(64 * MiB);
  expect(report.small?.encryptedSpoolBytes).toBeLessThan(MiB);
}, 600_000);
