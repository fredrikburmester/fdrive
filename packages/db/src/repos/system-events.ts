import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { systemEvents } from "../schema/app.js";
import { files, ocrLog, ocrRuns, roots, scans } from "../schema/idx.js";
import type {
  SystemEvent,
  SystemEventLevel,
  SystemEventListOptions,
  SystemEventRepo,
} from "./types.js";
import { levelsAtLeast } from "./types.js";

/**
 * Orders a merged page newest first, breaking ties on identical timestamps
 * with the numeric id so a page boundary is stable within one source.
 */
function byNewest(a: { at: Date; sortId: number }, b: { at: Date; sortId: number }): number {
  const delta = b.at.getTime() - a.at.getTime();
  return delta !== 0 ? delta : b.sortId - a.sortId;
}

interface Sortable extends SystemEvent {
  readonly sortId: number;
}

function strip(entries: Sortable[], limit: number): SystemEvent[] {
  return entries
    .sort(byNewest)
    .slice(0, limit)
    .map(({ sortId: _sortId, ...entry }) => entry);
}

/**
 * The API's own rows for `subsystem`, newest first. This is the only source
 * `append` and `prune` touch; the sidecar sources below are read-only
 * history the indexer and OCR services already maintain.
 */
async function readApiEvents(
  db: Db,
  subsystem: string,
  opts: SystemEventListOptions,
): Promise<Sortable[]> {
  const rows = await db
    .select()
    .from(systemEvents)
    .where(
      and(
        eq(systemEvents.subsystem, subsystem),
        inArray(systemEvents.level, levelsAtLeast(opts.minLevel)),
        ...(opts.before === undefined ? [] : [lt(systemEvents.at, opts.before)]),
      ),
    )
    .orderBy(desc(systemEvents.at), desc(systemEvents.id))
    .limit(opts.limit);

  return rows.map((row) => ({
    id: `api:${row.id}`,
    at: row.at,
    subsystem,
    level: row.level as SystemEventLevel,
    message: row.message,
    data: row.data ?? null,
    source: "api" as const,
    sortId: row.id,
  }));
}

/** `idx.scans`, one entry per finished (or started) scan of a root. */
async function readScanEvents(db: Db, opts: SystemEventListOptions): Promise<Sortable[]> {
  const levels = levelsAtLeast(opts.minLevel);
  // A scan is `info` unless it recorded errors, so an `error` filter can
  // never match one and a `warn` filter only matches scans with errors.
  if (!levels.includes("info") && !levels.includes("warn")) {
    return [];
  }
  const at = sql<Date>`coalesce(${scans.finishedAt}, ${scans.startedAt})`;
  const rows = await db
    .select({
      id: scans.id,
      at,
      root: roots.name,
      filesSeen: scans.filesSeen,
      filesChanged: scans.filesChanged,
      filesDeleted: scans.filesDeleted,
      errors: scans.errors,
    })
    .from(scans)
    .innerJoin(roots, eq(roots.id, scans.rootId))
    .where(
      and(
        ...(levels.includes("info") ? [] : [sql`${scans.errors} > 0`]),
        ...(opts.before === undefined ? [] : [sql`${at} < ${opts.before}`]),
      ),
    )
    .orderBy(sql`${at} desc`, desc(scans.id))
    .limit(opts.limit);

  return rows.map((row) => ({
    id: `scan:${row.id}`,
    at: new Date(row.at),
    subsystem: "indexer",
    level: (row.errors > 0 ? "warn" : "info") as SystemEventLevel,
    message: `Scan of ${row.root} finished: ${row.filesSeen} seen, ${row.filesChanged} changed, ${row.filesDeleted} deleted`,
    data: { root: row.root, errors: row.errors },
    source: "indexer" as const,
    sortId: row.id,
  }));
}

/** `idx.files` rows the indexer marked as extraction failures. */
async function readFileErrorEvents(db: Db, opts: SystemEventListOptions): Promise<Sortable[]> {
  const at = sql<Date>`coalesce(${files.indexedAt}, ${files.lastSeen})`;
  const rows = await db
    .select({ id: files.id, at, path: files.path, error: files.error })
    .from(files)
    .where(
      and(
        eq(files.textStatus, "error"),
        isNull(files.deletedAt),
        ...(opts.before === undefined ? [] : [sql`${at} < ${opts.before}`]),
      ),
    )
    .orderBy(sql`${at} desc nulls last`, desc(files.id))
    .limit(opts.limit);

  return rows.map((row) => ({
    id: `file:${row.id}`,
    at: row.at === null ? new Date(0) : new Date(row.at),
    subsystem: "indexer",
    level: "error" as SystemEventLevel,
    message: `${row.path}: ${row.error ?? "extraction failed"}`,
    data: { path: row.path },
    source: "indexer" as const,
    sortId: row.id,
  }));
}

/** `idx.ocr_runs`, one entry per OCR pass. */
async function readOcrRunEvents(db: Db, opts: SystemEventListOptions): Promise<Sortable[]> {
  const levels = levelsAtLeast(opts.minLevel);
  if (!levels.includes("info") && !levels.includes("warn")) {
    return [];
  }
  const at = sql<Date>`coalesce(${ocrRuns.finishedAt}, ${ocrRuns.startedAt})`;
  const rows = await db
    .select({
      id: ocrRuns.id,
      at,
      seen: ocrRuns.seen,
      ocred: ocrRuns.ocred,
      skipped: ocrRuns.skipped,
      failed: ocrRuns.failed,
    })
    .from(ocrRuns)
    .where(
      and(
        ...(levels.includes("info") ? [] : [sql`${ocrRuns.failed} > 0`]),
        ...(opts.before === undefined ? [] : [sql`${at} < ${opts.before}`]),
      ),
    )
    .orderBy(sql`${at} desc`, desc(ocrRuns.id))
    .limit(opts.limit);

  return rows.map((row) => ({
    id: `ocrrun:${row.id}`,
    at: new Date(row.at),
    subsystem: "ocr",
    level: (row.failed > 0 ? "warn" : "info") as SystemEventLevel,
    message: `OCR run finished: ${row.seen} seen, ${row.ocred} converted, ${row.skipped} skipped, ${row.failed} failed`,
    data: { failed: row.failed },
    source: "ocr" as const,
    sortId: row.id,
  }));
}

/** `idx.ocr_log` rows for files OCR could not convert. */
async function readOcrFailureEvents(db: Db, opts: SystemEventListOptions): Promise<Sortable[]> {
  const rows = await db
    .select({
      id: ocrLog.id,
      at: ocrLog.at,
      path: ocrLog.path,
      status: ocrLog.status,
      detail: ocrLog.detail,
    })
    .from(ocrLog)
    .where(
      and(
        inArray(ocrLog.status, ["failed", "timeout"]),
        ...(opts.before === undefined ? [] : [lt(ocrLog.at, opts.before)]),
      ),
    )
    .orderBy(sql`${ocrLog.at} desc nulls last`, desc(ocrLog.id))
    .limit(opts.limit);

  return rows.map((row) => ({
    id: `ocrlog:${row.id}`,
    at: row.at ?? new Date(0),
    subsystem: "ocr",
    level: "error" as SystemEventLevel,
    message: `${row.path}: ${row.detail ?? row.status}`,
    data: { path: row.path, status: row.status },
    source: "ocr" as const,
    sortId: row.id,
  }));
}

/**
 * The Postgres-backed event log. `list` reads each source separately
 * (every one level-, `before`- and limit-filtered on its own) and merges
 * them in TypeScript, so no source can crowd the others out of its own
 * query and the merged page is still bounded by `limit`.
 */
export function createSystemEventRepo(db: Db): SystemEventRepo {
  return {
    async append(input) {
      await db.insert(systemEvents).values({
        subsystem: input.subsystem,
        level: input.level,
        message: input.message,
        data: input.data ?? null,
      });
    },
    async list(subsystem, opts) {
      const sources: Promise<Sortable[]>[] = [readApiEvents(db, subsystem, opts)];
      if (subsystem === "indexer") {
        sources.push(readScanEvents(db, opts), readFileErrorEvents(db, opts));
      }
      if (subsystem === "ocr") {
        sources.push(readOcrRunEvents(db, opts), readOcrFailureEvents(db, opts));
      }
      const merged = (await Promise.all(sources)).flat();
      return strip(merged, opts.limit);
    },
    async prune(subsystem, keep) {
      await db.execute(sql`
        delete from "app"."system_events"
        where subsystem = ${subsystem}
          and id not in (
            select id from "app"."system_events"
            where subsystem = ${subsystem}
            order by at desc, id desc
            limit ${keep}
          )
      `);
    },
  };
}
