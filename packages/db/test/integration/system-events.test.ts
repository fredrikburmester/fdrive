import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  createSystemEventRepo,
  type Db,
  migrate,
  type SystemEventRepo,
  schema,
} from "../../src/index.js";

let container: StartedPostgreSqlContainer;
let db: Db;
let close: () => Promise<void>;
let repo: SystemEventRepo;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase("fdrive_test")
    .withUsername("fdrive")
    .withPassword("fdrive")
    .start();

  const created = createDb(container.getConnectionUri());
  db = created.db;
  close = created.close;
  await migrate(db);
  repo = createSystemEventRepo(db);
}, 180_000);

afterAll(async () => {
  await close();
  await container.stop();
}, 180_000);

beforeEach(async () => {
  await db.execute(
    sql`truncate table idx.roots, idx.ocr_runs, app.system_events restart identity cascade`,
  );
});

/** Distinct, ordered instants so every assertion below is about ordering, not clock resolution. */
function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 12, minutes, 0));
}

async function insertRoot(name: string): Promise<number> {
  const [row] = await db.insert(schema.roots).values({ name }).returning();
  if (row === undefined) throw new Error("expected a root");
  return row.id;
}

describe("system event log: indexer merge", () => {
  it("merges API rows, scans and file extraction errors newest first", async () => {
    const rootId = await insertRoot("sftpgo");
    await db.insert(schema.scans).values({
      rootId,
      startedAt: at(1),
      finishedAt: at(2),
      filesSeen: 10,
      filesChanged: 3,
      filesDeleted: 1,
      errors: 0,
    });
    await db.insert(schema.files).values({
      rootId,
      path: "docs/broken.pdf",
      name: "broken.pdf",
      size: 12,
      mtimeNs: 1n,
      textStatus: "error",
      error: "unsupported encoding",
      indexedAt: at(3),
    });
    await db.execute(
      sql`insert into app.system_events (at, subsystem, level, message, data)
          values (${at(4)}, 'indexer', 'info', 'Reindex requested', ${JSON.stringify({ root: "sftpgo" })}::jsonb)`,
    );

    const entries = await repo.list("indexer", { limit: 10 });

    expect(entries.map((entry) => [entry.source, entry.level, entry.message])).toEqual([
      ["api", "info", "Reindex requested"],
      ["indexer", "error", "docs/broken.pdf: unsupported encoding"],
      ["indexer", "info", "Scan of sftpgo finished: 10 seen, 3 changed, 1 deleted"],
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["api:1", "file:1", "scan:1"]);
  });

  it("reports a scan that recorded errors as a warning and drops it below an error filter", async () => {
    const rootId = await insertRoot("sftpgo");
    await db.insert(schema.scans).values({
      rootId,
      startedAt: at(1),
      finishedAt: null,
      filesSeen: 2,
      filesChanged: 0,
      filesDeleted: 0,
      errors: 4,
    });

    const warnPlus = await repo.list("indexer", { limit: 10, minLevel: "warn" });
    const errorsOnly = await repo.list("indexer", { limit: 10, minLevel: "error" });

    expect(warnPlus).toHaveLength(1);
    expect(warnPlus[0]).toMatchObject({ level: "warn", at: at(1), data: { errors: 4 } });
    expect(errorsOnly).toEqual([]);
  });

  it("applies the before cursor and the limit across every source", async () => {
    const rootId = await insertRoot("sftpgo");
    await db.insert(schema.scans).values({
      rootId,
      startedAt: at(1),
      finishedAt: at(1),
      filesSeen: 1,
      filesChanged: 0,
      filesDeleted: 0,
      errors: 0,
    });
    await db.insert(schema.files).values({
      rootId,
      path: "a.pdf",
      name: "a.pdf",
      size: 1,
      mtimeNs: 1n,
      textStatus: "error",
      error: null,
      indexedAt: at(5),
    });

    const limited = await repo.list("indexer", { limit: 1 });
    expect(limited.map((entry) => entry.message)).toEqual(["a.pdf: extraction failed"]);

    const older = await repo.list("indexer", { limit: 10, before: at(5) });
    expect(older.map((entry) => entry.source)).toEqual(["indexer"]);
    expect(older[0]?.message).toContain("Scan of sftpgo");
  });
});

describe("system event log: ocr merge", () => {
  it("merges OCR runs and per-file failures, and ignores succeeded log rows", async () => {
    const rootId = await insertRoot("sftpgo");
    await db.insert(schema.ocrRuns).values({
      startedAt: at(1),
      finishedAt: at(2),
      seen: 5,
      ocred: 4,
      skipped: 0,
      failed: 1,
    });
    await db.insert(schema.ocrLog).values([
      {
        rootId,
        path: "scan.pdf",
        size: 1,
        mtimeNs: 1n,
        status: "failed",
        detail: "ocrmypdf exited 2",
        at: at(3),
      },
      {
        rootId,
        path: "slow.pdf",
        size: 2,
        mtimeNs: 2n,
        status: "timeout",
        detail: null,
        at: at(4),
      },
      { rootId, path: "ok.pdf", size: 3, mtimeNs: 3n, status: "ok", detail: null, at: at(5) },
    ]);

    const entries = await repo.list("ocr", { limit: 10 });

    expect(entries.map((entry) => [entry.level, entry.message])).toEqual([
      ["error", "slow.pdf: timeout"],
      ["error", "scan.pdf: ocrmypdf exited 2"],
      ["warn", "OCR run finished: 5 seen, 4 converted, 0 skipped, 1 failed"],
    ]);
    expect(entries.every((entry) => entry.source === "ocr")).toBe(true);
  });

  it("keeps sidecar history out of subsystems that have none", async () => {
    await db.insert(schema.ocrRuns).values({
      startedAt: at(1),
      finishedAt: at(1),
      seen: 1,
      ocred: 1,
      skipped: 0,
      failed: 0,
    });
    await repo.append({ subsystem: "search", level: "info", message: "Reembed requested" });

    const entries = await repo.list("search", { limit: 10 });

    expect(entries.map((entry) => entry.message)).toEqual(["Reembed requested"]);
  });
});
