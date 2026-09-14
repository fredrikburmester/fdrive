import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createDb, migrate } from "@fdrive/db";
import { startPostgres } from "@fdrive/testkit";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  BackupStore,
  captureSnapshot,
  localBlobs,
  restoreArchive,
  withBackupWriter,
} from "../../src/index.js";
import { secrets } from "../helpers.js";

/**
 * Publishes measured capture/restore costs for the operator documentation. Numbers are local
 * observations on the test host; the assertions only guard the fixture shapes.
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
        "insert into idx.events(root_id,path,kind) select 1,'folder/file-'||g||'.pdf','upsert' from generate_series(1,50000) g",
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
    // A cooperating writer asks for the shared checkpoint lock shortly after capture starts;
    // its wait is the pause every fdrive-owned recovery writer experiences.
    let writerPauseMs = 0;
    const writer = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = performance.now();
      await withBackupWriter(db.pool, async () => undefined);
      writerPauseMs = Math.round(performance.now() - started);
    })();
    const capture = await measure(() =>
      captureSnapshot(
        {
          pool: db.pool,
          masterKey: randomBytes(32).toString("base64"),
          environment: { release: "benchmark" },
          blobs: async () => ({ sources: await localBlobs(recovery, "desktop"), coverage: [] }),
        },
        { id: randomUUID(), installationId: config.installation_id, recipient, output },
      ),
    );
    await writer;
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
      captureAndWriterPauseMs: writerPauseMs,
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
