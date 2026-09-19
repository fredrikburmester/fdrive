import {
  ActivityFileResponse,
  CanonicalUuid,
  ClientActivityRequest,
  PersonalActivityEvent,
  PersonalActivityFilters,
  type PersonalActivityResponse,
  ROUTES,
} from "@fdrive/contracts";
import type {
  ActivityEventRecord,
  ActivityListOptions,
  ActivityReadsRepo,
  ActivityRepo,
  IdentityRepo,
} from "@fdrive/db";
import { streamSSE } from "hono/streaming";
import { accountContext } from "../accounts/routes.js";
import type { AppHono, AuthedHono } from "../app.js";
import type { IdentityStorageFactory } from "../auth/storage-factory.js";
import { ApiHttpError } from "../errors.js";
import type { FsContext } from "../fs/routes.js";
import { normalizeOrThrow, parseBody } from "../fs/routes.js";
import { createReadAuthorizer } from "../scoping/read-authorizer.js";
import type { ActivityAdmission } from "./admission.js";
import { createActivityCursors } from "./cursor.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from a route path, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface PersonalActivityRoutesDeps {
  readonly admitActivity: ActivityAdmission;
  readonly reads: ActivityReadsRepo;
  readonly repo: ActivityRepo;
  readonly identities: IdentityRepo;
  readonly storageFactory: IdentityStorageFactory;
  readonly cursorSecret: string;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Drops every private column the store keeps: owner IDs, idempotency keys and producer IDs. */
export function serializeActivity(
  event: ActivityEventRecord,
  subjects: Awaited<ReturnType<ActivityRepo["subjects"]>>,
): PersonalActivityEvent {
  return PersonalActivityEvent.parse({
    ...event,
    sequence: String(event.ownerSequence),
    occurredAt: iso(event.occurredAt),
    recordedAt: iso(event.recordedAt),
    sortAt: iso(event.sortAt),
    detectedAt: iso(event.detectedAt),
    lastConfirmedAt: iso(event.lastConfirmedAt),
    firstAt: iso(event.firstAt),
    lastAt: iso(event.lastAt),
    subjects: subjects.slice(0, 20),
    subjectsTruncated: subjects.length > 20,
  });
}

/**
 * Presents an open read window as one provisional event. The window is still
 * being aggregated, so it carries no sequence and is marked provisional: the
 * client must not treat it as a committed history row.
 */
export function serializeReadWindow(
  window: Awaited<ReturnType<ActivityReadsRepo["provisional"]>>[number],
): PersonalActivityEvent {
  const [only, ...rest] = Object.entries(window.outcomeCounts).filter(([, count]) => count);
  // One outcome for every read in the window, a mix the UI shows as partial,
  // or nothing recorded yet, which is not the same as a failure.
  let outcome = "unknown";
  if (only) outcome = rest.length ? "partial" : only[0];
  return PersonalActivityEvent.parse({
    id: window.id,
    sequence: "0",
    identityId: window.identityId,
    actorAccountId: window.ownerAccountId,
    fileId: window.fileId,
    class: "action",
    action: window.action,
    stage: "outcome",
    outcome,
    source: window.source,
    evidence: window.evidence,
    operationId: null,
    batchId: null,
    parentEventId: null,
    occurredAt: window.lastAt.toISOString(),
    recordedAt: window.bucketStart.toISOString(),
    sortAt: window.lastAt.toISOString(),
    lastConfirmedAt: null,
    detectedAt: null,
    before: null,
    after: { path: window.path },
    detail: null,
    errorCode: null,
    count: window.count,
    firstAt: window.firstAt.toISOString(),
    lastAt: window.lastAt.toISOString(),
    outcomeCounts: window.outcomeCounts,
    subjects: [
      {
        fileId: window.fileId,
        identityId: window.identityId,
        role: "primary",
        ordinal: 0,
        path: window.path,
        revisionId: null,
      },
    ],
    subjectsTruncated: false,
    provisional: true,
  });
}

/** A full page hands back a cursor at its last row; a short page ends the list. */
function pageCursor<T>(
  rows: readonly T[],
  position: (row: T) => string,
  sign: (value: string) => string,
): string | null {
  const last = rows.length === 100 ? rows.at(-1) : undefined;
  return last ? sign(position(last)) : null;
}

function uuid(value: string | undefined) {
  const parsed = CanonicalUuid.safeParse(value);
  if (!parsed.success) throw new ApiHttpError("bad_request", "Invalid activity ID");
  return parsed.data;
}

/**
 * Registers the caller's own history: the filtered feed, one file's journey
 * with its lineage and revisions, one batch's outcomes, immutable event
 * details, and the live sequence stream. Every route is account-session only,
 * since history is private to the person and an API token is not a person.
 */
export function registerPersonalActivityRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: PersonalActivityRoutesDeps,
) {
  const { authed } = groups;
  const cursors = createActivityCursors(deps.cursorSecret);
  const files = routePath(ROUTES.activity.files);
  const events = routePath(ROUTES.activity.events);

  authed.post(routePath(ROUTES.activity.clientEvents), async (c) =>
    c.json({ id: await deps.admitActivity(c, await parseBody(ClientActivityRequest, c)) }, 202),
  );

  async function feed(c: FsContext, scope: { fileId?: string; batchId?: string } = {}) {
    const { principal } = accountContext(c);
    const parsed = PersonalActivityFilters.safeParse(c.req.query());
    if (!parsed.success) throw new ApiHttpError("bad_request", "Invalid activity filters");
    const { cursor, from, to, ...filters } = parsed.data;
    const options: ActivityListOptions = {
      limit: filters.limit,
      ...scope,
      ...(filters.identityId ? { identityId: filters.identityId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.source ? { source: filters.source } : {}),
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: new Date(to) } : {}),
    };
    const binding = JSON.stringify({ ...filters, from, to, ...scope });
    let after: ActivityListOptions["after"];
    if (cursor) {
      const value: unknown = JSON.parse(cursors.decode(principal.accountId, binding, cursor));
      if (
        !Array.isArray(value) ||
        typeof value[0] !== "string" ||
        !Number.isFinite(Date.parse(value[0])) ||
        !CanonicalUuid.safeParse(value[1]).success
      )
        throw new ApiHttpError("bad_request", "Invalid activity cursor position");
      after = { at: new Date(value[0]), id: String(value[1]) };
    }
    const rows = await deps.repo.list(principal.accountId, {
      ...options,
      ...(after ? { after } : {}),
    });
    const subjects = await deps.repo.subjects(
      principal.accountId,
      rows.map((row) => row.id),
    );
    const boundary = await deps.repo.boundary(principal.accountId);
    const last = rows.at(-1);
    // Open read windows belong at the top of the first page only. A later page
    // or a batch view would show them a second time, out of order.
    const reads =
      cursor || scope.batchId
        ? []
        : await deps.reads.provisional(principal.accountId, filters.identityId);
    const body: PersonalActivityResponse = {
      items: rows.map((row) =>
        serializeActivity(
          row,
          subjects.filter((subject) => subject.eventId === row.id),
        ),
      ),
      provisionalReads: reads
        .filter(
          (row) =>
            (!scope.fileId || row.fileId === scope.fileId) &&
            (!filters.action || row.action === filters.action) &&
            (!filters.source || row.source === filters.source) &&
            (!filters.q || row.path.toLocaleLowerCase().includes(filters.q.toLocaleLowerCase())) &&
            (!from || row.lastAt >= new Date(from)) &&
            (!to || row.lastAt <= new Date(to)) &&
            (!filters.outcome || filters.outcome === serializeReadWindow(row).outcome),
        )
        .map(serializeReadWindow),
      nextCursor:
        rows.length === filters.limit && last
          ? cursors.encode(
              principal.accountId,
              binding,
              JSON.stringify([last.sortAt.toISOString(), last.id]),
            )
          : null,
      historyStartsAt: boundary?.historyStartsAt.toISOString() ?? null,
      retainedFrom: boundary?.retainedFrom?.toISOString() ?? null,
      ...(scope.batchId
        ? { batchSummary: await deps.repo.batchSummary(principal.accountId, scope.batchId) }
        : {}),
      coverage: {
        mutations: true,
        reads: true,
        // Nothing detects changes made outside fdrive yet, so the UI must keep
        // saying so. Provider watchers and refresh reconciliation are slice 3.
        observations: "unavailable",
        observationGap: true,
      },
    };
    return c.json(body);
  }

  authed.get(routePath(ROUTES.activity.feed), (c) => feed(c));
  authed.get(routePath(ROUTES.activity.locations), async (c) =>
    c.json({ items: await deps.repo.locations(accountContext(c).principal.accountId) }),
  );
  authed.get(routePath(ROUTES.activity.resolveFile), async (c) => {
    const { principal } = accountContext(c);
    const identityId = uuid(c.req.query("identityId"));
    const path = normalizeOrThrow(c.req.query("path") ?? "");
    const id = await deps.repo.resolveFile(principal.accountId, identityId, path);
    if (!id) throw new ApiHttpError("not_found", "No recorded history for this file yet");
    return c.json({ id });
  });
  authed.get(`${files}/:fileId/events`, (c) => feed(c, { fileId: uuid(c.req.param("fileId")) }));
  authed.get(`${routePath(ROUTES.activity.batches)}/:batchId/events`, (c) =>
    feed(c, { batchId: uuid(c.req.param("batchId")) }),
  );
  authed.get(`${events}/:eventId`, async (c) => {
    const { principal } = accountContext(c);
    const event = await deps.repo.event(principal.accountId, uuid(c.req.param("eventId")));
    if (!event) throw new ApiHttpError("not_found", "Activity not found");
    return c.json(
      serializeActivity(event, await deps.repo.subjects(principal.accountId, [event.id])),
    );
  });
  authed.get(`${events}/:eventId/subjects`, async (c) => {
    const { principal } = accountContext(c);
    const eventId = uuid(c.req.param("eventId"));
    if (!(await deps.repo.event(principal.accountId, eventId)))
      throw new ApiHttpError("not_found", "Activity not found");
    const binding = `subjects:${eventId}`;
    const cursor = c.req.query("cursor");
    const value = cursor ? cursors.decode(principal.accountId, binding, cursor) : "-1";
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new ApiHttpError("bad_request", "Invalid subject cursor");
    const rows = await deps.repo.subjectPage(principal.accountId, eventId, Number(value));
    return c.json({
      items: rows.map(({ ownerAccountId: _owner, eventId: _event, ...row }) => row),
      nextCursor: pageCursor(
        rows,
        (row) => String(row.ordinal),
        (value) => cursors.encode(principal.accountId, binding, value),
      ),
    });
  });
  authed.get(`${files}/:fileId/revisions`, async (c) => {
    const { principal } = accountContext(c);
    const fileId = uuid(c.req.param("fileId"));
    const cursor = c.req.query("cursor");
    const binding = `revisions:${fileId}`;
    const rows = await deps.repo.revisions(
      principal.accountId,
      fileId,
      cursor ? uuid(cursors.decode(principal.accountId, binding, cursor)) : undefined,
    );
    return c.json({
      items: rows.map(({ ownerAccountId: _owner, ...row }) => row),
      nextCursor: pageCursor(
        rows,
        (row) => row.id,
        (value) => cursors.encode(principal.accountId, binding, value),
      ),
    });
  });
  authed.get(`${files}/:fileId/lineage`, async (c) => {
    const { principal } = accountContext(c);
    const fileId = uuid(c.req.param("fileId"));
    const after = c.req.query("cursor");
    const binding = `lineage:${fileId}`;
    const rows = await deps.repo.lineage(
      principal.accountId,
      fileId,
      after ? uuid(cursors.decode(principal.accountId, binding, after)) : undefined,
    );
    const subjects = await deps.repo.subjects(principal.accountId, [
      ...new Set(rows.map((row) => row.eventId)),
    ]);
    return c.json({
      items: rows.map(({ ownerAccountId: _owner, ...row }) => ({
        ...row,
        sourcePath:
          subjects.find((s) => s.eventId === row.eventId && s.fileId === row.sourceFileId)?.path ??
          null,
        targetPath:
          subjects.find((s) => s.eventId === row.eventId && s.fileId === row.targetFileId)?.path ??
          null,
      })),
      nextCursor: pageCursor(
        rows,
        (row) => row.id,
        (value) => cursors.encode(principal.accountId, binding, value),
      ),
    });
  });
  authed.get(`${files}/:fileId`, async (c) => {
    const { principal } = accountContext(c);
    const result = await deps.repo.file(principal.accountId, uuid(c.req.param("fileId")));
    if (!result) throw new ApiHttpError("not_found", "File journey not found");
    const { file, storage, lastSubject, lastEvent } = result;
    let currentPath: string | null = null;
    let availability: ActivityFileResponse["availability"] = "unavailable";
    // History survives an unlinked login, but the current location does not:
    // only a still-linked identity may be probed for where the file is now.
    const identity = await deps.identities.get(file.identityId);
    if (identity?.accountId === principal.accountId) {
      availability = file.state;
      if (file.state === "live") {
        try {
          const provider = await deps.storageFactory(file.identityId);
          const read = await createReadAuthorizer({ storage: provider }).authorize({
            path: file.path,
            kind: file.kind,
          });
          if (read.allowed) currentPath = file.path;
          else availability = read.reason === "missing" ? "unknown" : "unavailable";
        } catch {
          availability = "unavailable";
        }
      }
    }
    return c.json(
      ActivityFileResponse.parse({
        id: file.id,
        identityId: file.identityId,
        label: storage.label,
        kind: file.kind,
        lastKnownPath: lastSubject.path ?? lastEvent.after?.path ?? lastEvent.before?.path ?? "/",
        currentPath,
        availability,
        lastConfirmedAt:
          lastEvent.lastConfirmedAt?.toISOString() ?? lastEvent.occurredAt?.toISOString() ?? null,
        revisionId: lastSubject.revisionId,
      }),
    );
  });
  authed.get(routePath(ROUTES.activity.stream), async (c) => {
    const { principal } = accountContext(c);
    const cursor = c.req.header("last-event-id") ?? c.req.query("cursor");
    const value = cursor
      ? cursors.decode(principal.accountId, "stream", cursor)
      : String(((await deps.repo.boundary(principal.accountId))?.nextSequence ?? 1) - 1);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new ApiHttpError("bad_request", "Invalid activity stream cursor");
    let sequence = Number(value);
    return streamSSE(
      c,
      async (stream) => {
        // The opening frame hands the client a cursor for the position it
        // started from, so a reconnect never replays what it already had.
        if (!cursor)
          await stream.writeSSE({
            event: "activity",
            id: cursors.encode(principal.accountId, "stream", value),
            data: "{}",
          });
        while (!stream.aborted && !c.req.raw.signal.aborted) {
          if (principal.verifyAuthority && !(await principal.verifyAuthority())) break;
          const rows = await deps.repo.stream(principal.accountId, sequence);
          for (const row of rows) {
            sequence = row.sequence;
            await stream.writeSSE({
              event: "activity",
              id: cursors.encode(principal.accountId, "stream", String(sequence)),
              data: JSON.stringify({ id: row.id }),
            });
          }
          if (rows.length < 100) {
            await stream.writeSSE({ event: "ping", data: "{}" });
            await stream.sleep(2000);
          }
        }
      },
      async (error) => {
        // Hono serializes error.message after this callback. Never expose a
        // database or provider error; clients reconnect from their cursor.
        error.message = "Activity stream interrupted";
      },
    );
  });
}
