import { CanonicalUuid, PersonalActivityFilters, ROUTES } from "@fdrive/contracts";
import type { ActivityExportsRepo, ActivityListOptions, ActivityRepo } from "@fdrive/db";
import { z } from "zod";
import { accountContext } from "../accounts/routes.ts";
import type { AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { parseBody } from "../fs/routes.js";
import { createActivityLimiter } from "./limiter.js";
import { routePath, serializeActivity, serializeReadWindow } from "./routes.js";

const ExportFilters = PersonalActivityFilters.omit({ cursor: true, limit: true }).extend({
  fileId: CanonicalUuid.optional(),
  batchId: CanonicalUuid.optional(),
});
const ExportRequest = z.strictObject({
  format: z.enum(["json", "csv"]),
  filters: ExportFilters.default({}),
});
/** Quote every field and neutralize spreadsheet formulas, including whitespace prefixes. */
export function activityCsv(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
}
export async function* activityExport(
  repo: ActivityRepo,
  exports: ActivityExportsRepo,
  accountId: string,
  snapshot: NonNullable<Awaited<ReturnType<ActivityExportsRepo["get"]>>>,
) {
  const filters = ExportFilters.parse(snapshot.filters);
  const options: ActivityListOptions = {
    ...(filters.fileId ? { fileId: filters.fileId } : {}),
    ...(filters.batchId ? { batchId: filters.batchId } : {}),
    ...(filters.identityId ? { identityId: filters.identityId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.from ? { from: new Date(filters.from) } : {}),
    ...(filters.to ? { to: new Date(filters.to) } : {}),
    snapshotSequence: snapshot.snapshotSequence,
    limit: 100,
  };
  const boundary = await repo.boundary(accountId);
  const json = snapshot.format === "json";
  yield json
    ? `${JSON.stringify({ schemaVersion: 1, snapshotSequence: snapshot.snapshotSequence, historyStartsAt: boundary?.historyStartsAt ?? null, retainedFrom: boundary?.retainedFrom ?? null }).slice(0, -1)},"events":[`
    : "record_type,event_id,action,outcome,source,at,identity_id,file_id,path,before,after,evidence,details\r\n";
  let firstEvent = true,
    after: ActivityListOptions["after"];
  while (true) {
    const events = await repo.list(accountId, { ...options, ...(after ? { after } : {}) });
    for (const event of events) {
      const value = serializeActivity(event, []);
      if (json) {
        const { subjects: _subjects, ...fields } = value;
        yield `${firstEvent ? "" : ","}${JSON.stringify(fields).slice(0, -1)},"subjects":[`;
      }
      firstEvent = false;
      let ordinal = -1,
        firstSubject = true;
      while (true) {
        const subjects = await repo.subjectPage(accountId, event.id, ordinal);
        for (const subject of subjects) {
          const { ownerAccountId: _owner, eventId: _event, ...publicSubject } = subject;
          yield json
            ? `${firstSubject ? "" : ","}${JSON.stringify(publicSubject)}`
            : [
                "event",
                event.id,
                event.action,
                event.outcome,
                event.source,
                event.sortAt.toISOString(),
                subject.identityId,
                subject.fileId,
                subject.path,
                event.before,
                event.after,
                event.evidence,
                {
                  role: subject.role,
                  revisionId: subject.revisionId,
                  count: event.count,
                  parentEventId: event.parentEventId,
                  errorCode: event.errorCode,
                },
              ]
                .map(activityCsv)
                .join(",") + "\r\n";
          firstSubject = false;
          ordinal = subject.ordinal;
        }
        if (subjects.length < 100) break;
      }
      if (json) yield "]}";
      else if (firstSubject)
        yield [
          "event",
          event.id,
          event.action,
          event.outcome,
          event.source,
          event.sortAt.toISOString(),
          event.identityId,
          event.fileId,
          event.after?.path ?? event.before?.path,
          event.before,
          event.after,
          event.evidence,
          value,
        ]
          .map(activityCsv)
          .join(",") + "\r\n";
    }
    const last = events.at(-1);
    if (events.length < 100 || !last) break;
    after = { at: last.sortAt, id: last.id };
  }
  let readCursor: string | undefined;
  while (true) {
    const rows = await exports.reads(accountId, snapshot.id, readCursor);
    for (const { payload: row, windowId } of rows) {
      readCursor = windowId;
      const value = serializeReadWindow({
        ...row,
        bucketStart: new Date(row.bucketStart),
        firstAt: new Date(row.firstAt),
        lastAt: new Date(row.lastAt),
      });
      if (
        filters.batchId ||
        (filters.fileId && row.fileId !== filters.fileId) ||
        (filters.identityId && row.identityId !== filters.identityId) ||
        (filters.action && row.action !== filters.action) ||
        (filters.source && row.source !== filters.source) ||
        (filters.outcome && value.outcome !== filters.outcome) ||
        (filters.q && !row.path.toLowerCase().includes(filters.q.toLowerCase())) ||
        (filters.from && new Date(row.lastAt) < new Date(filters.from)) ||
        (filters.to && new Date(row.lastAt) > new Date(filters.to))
      )
        continue;
      yield json
        ? `${firstEvent ? "" : ","}${JSON.stringify(value)}`
        : [
            "read_window",
            row.id,
            row.action,
            value.outcome,
            row.source,
            row.lastAt,
            row.identityId,
            row.fileId,
            row.path,
            null,
            value.after,
            row.evidence,
            value,
          ]
            .map(activityCsv)
            .join(",") + "\r\n";
      firstEvent = false;
    }
    if (rows.length < 100) break;
  }
  if (json) yield '],"lineage":[';
  let cursor: string | undefined,
    first = true;
  while (true) {
    const rows = await exports.lineage(accountId, snapshot.snapshotSequence, cursor, options);
    for (const { edge } of rows) {
      const { ownerAccountId: _owner, ...publicEdge } = edge;
      yield json
        ? `${first ? "" : ","}${JSON.stringify(publicEdge)}`
        : [
            "lineage",
            edge.eventId,
            "",
            "",
            "",
            "",
            edge.sourceIdentityId,
            edge.sourceFileId,
            "",
            "",
            "",
            edge.evidence,
            publicEdge,
          ]
            .map(activityCsv)
            .join(",") + "\r\n";
      cursor = edge.id;
      first = false;
    }
    if (rows.length < 100) break;
  }
  if (json) yield '],"revisions":[';
  cursor = undefined;
  first = true;
  while (true) {
    const rows = await exports.revisions(accountId, snapshot.snapshotSequence, cursor, options);
    for (const { revision } of rows) {
      const { ownerAccountId: _owner, ...publicRevision } = revision;
      yield json
        ? `${first ? "" : ","}${JSON.stringify(publicRevision)}`
        : [
            "revision",
            revision.eventId,
            "",
            "",
            "",
            "",
            revision.identityId,
            revision.fileId,
            "",
            "",
            "",
            "",
            publicRevision,
          ]
            .map(activityCsv)
            .join(",") + "\r\n";
      cursor = revision.id;
      first = false;
    }
    if (rows.length < 100) break;
  }
  if (json) yield "]}";
}
export function registerActivityExports(
  authed: AuthedHono,
  deps: { repo: ActivityRepo; exports: ActivityExportsRepo },
) {
  const base = routePath(ROUTES.activity.exports);
  // An export walks the whole account's history, so it gets a tighter budget
  // than a page of it. Snapshots are cheap; only downloading one does the work.
  const snapshots = createActivityLimiter(20);
  const downloads = createActivityLimiter(6);
  authed.post(base, async (c) => {
    const { principal } = accountContext(c);
    snapshots(principal.accountId);
    const input = await parseBody(ExportRequest, c);
    const filters = Object.fromEntries(
      Object.entries(input.filters).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const snapshot = await deps.exports.create(principal.accountId, input.format, filters);
    return c.json(
      {
        id: snapshot.id,
        state: "completed",
        format: snapshot.format,
        expiresAt: snapshot.expiresAt.toISOString(),
      },
      202,
    );
  });
  authed.get(`${base}/:id`, async (c) => {
    const { principal } = accountContext(c);
    const id = CanonicalUuid.safeParse(c.req.param("id"));
    const snapshot = id.success ? await deps.exports.get(principal.accountId, id.data) : null;
    if (!snapshot) throw new ApiHttpError("not_found", "Export not found or expired");
    return c.json({
      id: snapshot.id,
      state: snapshot.state,
      format: snapshot.format,
      expiresAt: snapshot.expiresAt.toISOString(),
    });
  });
  authed.get(`${base}/:id/download`, async (c) => {
    const { principal } = accountContext(c);
    downloads(principal.accountId);
    const id = CanonicalUuid.safeParse(c.req.param("id"));
    const snapshot = id.success ? await deps.exports.get(principal.accountId, id.data) : null;
    if (!snapshot) throw new ApiHttpError("not_found", "Export not found or expired");
    const iterator = activityExport(deps.repo, deps.exports, principal.accountId, snapshot);
    const encoder = new TextEncoder();
    let lastAuthorityCheck = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (Date.now() - lastAuthorityCheck >= 2000) {
          lastAuthorityCheck = Date.now();
          if (principal.verifyAuthority && !(await principal.verifyAuthority())) {
            await iterator.return();
            controller.error(new Error("Session expired"));
            return;
          }
        }
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      async cancel() {
        await iterator.return();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type":
          snapshot.format === "json"
            ? "application/json; charset=utf-8"
            : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="fdrive-activity.${snapshot.format}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
