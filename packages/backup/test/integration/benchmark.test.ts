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
  withDatabaseWriter,
} from "../../src/index.js";

/**
 * Publishes measured capture/restore costs for the operator documentation. Numbers are local
 * observations on the test host, so the assertions guard the fixture shapes and the checkpoint
 * contract (docs/BACKUPS.md), never a duration: a request waits only while the capture takes its
 * database snapshot, so requests run while it reads; a recovery file writer waits for the
 * capture to publish its archive.
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
async function gateHeld(pool: Pool, gate: number) {
  // A single bigint advisory key shows in pg_locks as classid = high 32 bits, objid = low 32 bits.
  const { rows } = await pool.query<{ held: boolean }>(
    `select exists (select 1 from pg_locks where locktype = 'advisory' and granted
       and mode = 'ExclusiveLock' and classid = ($1::bigint >> 32)::oid
       and objid = ($1::bigint & 4294967295)::oid and objsubid = 1
       and database = (select oid from pg_database where datname = current_database())) as held`,
    [gate],
  );
  return rows[0]?.held ?? false;
}
function settled(capture: Promise<unknown>) {
  const state = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  capture.then(settle, settle);
  return state;
}
/**
 * Mutating requests, one after another for as long as the capture runs. The longest wait is the
 * pause a request sees; `whileReading` counts the requests that started while the capture held
 * the recovery files gate and finished before it published.
 */
async function requests(pool: Pool, capture: Promise<unknown>, output: string) {
  const state = settled(capture);
  let pauseMs = 0;
  let whileReading = 0;
  while (!state.settled) {
    const reading = await gateHeld(pool, BACKUP_GATE);
    const started = performance.now();
    const published = await withDatabaseWriter(pool, async () => existsSync(output));
    pauseMs = Math.max(pauseMs, Math.round(performance.now() - started));
    if (reading && !published) whileReading++;
    await sleep(5);
  }
  return { pauseMs, whileReading };
}
/**
 * A recovery file writer, as OCR is, asking for the shared recovery files gate as soon as the
 * capture holds it: its wait is the pause OCR's rewrites see.
 */
async function recoveryWriter(pool: Pool, capture: Promise<unknown>, output: string) {
  const state = settled(capture);
  while (!state.settled && !(await gateHeld(pool, BACKUP_GATE))) await sleep(5);
  const client = await pool.connect();
  try {
    const started = performance.now();
    await client.query("select pg_advisory_lock_shared($1)", [BACKUP_GATE]);
    const pauseMs = Math.round(performance.now() - started);
    await client.query("select pg_advisory_unlock_shared($1)", [BACKUP_GATE]);
    return { pauseMs, published: existsSync(output) };
  } finally {
    client.release();
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

it("measures capture, request and recovery writer pauses, spool bytes and fresh restore for small and large fixtures", async () => {
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
    const [capture, request, writer] = await Promise.all([
      capturing,
      requests(db.pool, capturing, output),
      recoveryWriter(db.pool, capturing, output),
    ]);
    expect(writer.published).toBe(true);
    // Reading 64 MiB takes long enough for requests to run while it does.
    if (size === "large") expect(request.whileReading).toBeGreaterThan(0);
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
        reseal: (bytes) => bytes,
      }),
    );
    expect(restore.result.header.id).toBe(capture.result.manifest.id);
    report[size] = {
      historyRows,
      recoveryBytes,
      encryptedSpoolBytes: archiveBytes,
      captureMs: capture.ms,
      requestPauseMs: request.pauseMs,
      requestsWhileReading: request.whileReading,
      recoveryWriterPauseMs: writer.pauseMs,
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
