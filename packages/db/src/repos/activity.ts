import { ActivityBatchSummary, ActivityFacts, type ClientActivityRequest } from "@fdrive/contracts";
import { and, desc, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import {
  activityEventSubjects,
  activityEvents,
  activityFiles,
  activityLineage,
  activityOperations,
  activityOutbox,
  activityReadWindows,
  activityRevisions,
  activityStorageIdentities,
  activityStreams,
  activityTrashBindings,
} from "../schema/activity.js";
import {
  activityFileAt,
  activitySubject,
  applyActivityOutcome,
  ensureActivityFile,
  escapeActivityLike,
  lockActivityRegistry,
} from "./activity-registry.js";
import {
  ActivityConflict,
  type ActivityDb,
  type ActivityFinish,
  type ActivityListOptions,
  type ActivityOperationInput,
  type ActivityOperationRecord,
  requireActivityRow,
} from "./activity-types.js";
import { appendActivityEvent, captureActivityIdentity } from "./activity-writer.js";

export async function appendActivityOutcome(
  db: ActivityDb,
  operation: ActivityOperationRecord,
  result: ActivityFinish,
  now: Date,
  reconciliationOf?: string,
) {
  const stage = reconciliationOf ? "reconciliation" : "outcome";
  const key = `${operation.source}:${operation.id}:${stage}`;
  const existing = (
    await db
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.ownerAccountId, operation.ownerAccountId),
          eq(activityEvents.identityId, operation.identityId),
          eq(activityEvents.idempotencyKey, key),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return existing;
  let registry =
    result.outcome === "success" ? await applyActivityOutcome(db, operation, result, now) : null;
  if (result.outcome === "skipped" && operation.requested.path) {
    const file = await activityFileAt(db, operation.identityId, operation.requested.path);
    if (file)
      registry = {
        file,
        source: null,
        subjects: [activitySubject(file, "primary")],
        revisionId: null,
      };
  }
  const intent = (
    await db
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.ownerAccountId, operation.ownerAccountId),
          eq(activityEvents.operationId, operation.id),
          eq(activityEvents.stage, "intent"),
        ),
      )
      .limit(1)
  )[0];
  const captured = intent
    ? await db
        .select()
        .from(activityEventSubjects)
        .where(
          and(
            eq(activityEventSubjects.ownerAccountId, operation.ownerAccountId),
            eq(activityEventSubjects.eventId, intent.id),
            eq(activityEventSubjects.role, "affected"),
          ),
        )
        .orderBy(activityEventSubjects.ordinal)
    : [];
  const parent = operation.parentOperationId
    ? (
        await db
          .select()
          .from(activityEvents)
          .where(
            and(
              eq(activityEvents.ownerAccountId, operation.ownerAccountId),
              eq(activityEvents.operationId, operation.parentOperationId),
              eq(activityEvents.stage, "intent"),
            ),
          )
          .limit(1)
      )[0]
    : null;
  const subjects = registry?.subjects.length
    ? [...registry.subjects]
    : [
        {
          fileId: operation.fileId,
          identityId: operation.identityId,
          role: "primary" as const,
          ordinal: 0,
          path: operation.requested.path ?? null,
          revisionId: operation.revisionId,
        },
      ];
  for (const subject of [...captured, ...(result.subjects ?? [])])
    if (
      !subjects.some((entry) =>
        subject.fileId
          ? entry.fileId === subject.fileId
          : !entry.fileId && entry.identityId === subject.identityId && entry.path === subject.path,
      )
    )
      subjects.push({ ...subject, ordinal: subjects.length });
  const event = await appendActivityEvent(
    db,
    {
      accountId: operation.ownerAccountId,
      identityId: operation.identityId,
      action: operation.action,
      source: operation.source,
      evidence: reconciliationOf ? "reconciled" : "server_confirmed",
      stage,
      outcome: result.outcome,
      operationId: operation.id,
      ...(reconciliationOf || parent
        ? { parentEventId: reconciliationOf ?? parent?.id ?? "" }
        : {}),
      producerOperationId: operation.producerOperationId,
      ...(operation.batchId ? { batchId: operation.batchId } : {}),
      idempotencyKey: key,
      ...((registry ? registry.file?.id : operation.fileId)
        ? { fileId: (registry ? registry.file?.id : operation.fileId) as string }
        : {}),
      before: result.before ?? operation.before ?? operation.requested,
      ...(result.after ? { after: result.after } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      occurredAt: result.at ?? now,
      subjects,
    },
    now,
  );
  if (registry?.file && registry.revisionId) {
    await db.insert(activityRevisions).values({
      id: registry.revisionId,
      fileId: registry.file.id,
      identityId: operation.identityId,
      ownerAccountId: operation.ownerAccountId,
      eventId: event.id,
      previousRevisionId: operation.revisionId ?? registry.source?.revisionId ?? null,
      size: result.after?.size ?? null,
      sha256: result.after?.sha256 ?? null,
      providerVersion: result.after?.version ?? null,
    });
  }
  if (operation.action === "file.copy" && registry?.source && registry.file) {
    await db.insert(activityLineage).values({
      ownerAccountId: operation.ownerAccountId,
      eventId: event.id,
      sourceFileId: registry.source.id,
      sourceIdentityId: registry.source.identityId,
      targetFileId: registry.file.id,
      targetIdentityId: registry.file.identityId,
      kind: operation.requested.variant === "save_as" ? "save_as" : "copy",
      evidence: "server_confirmed",
    });
  }
  if (operation.action === "file.trash" && registry?.file) {
    await db.insert(activityTrashBindings).values({
      ownerAccountId: operation.ownerAccountId,
      eventId: event.id,
      fileId: registry.file.id,
      identityId: operation.identityId,
      strategy: result.after?.trashStrategy ?? "sftpgo_rule",
      originalPath: operation.requested.path ?? registry.file.path,
      trashLeaf: result.after?.trashLeaf ?? null,
      state: result.after?.trashLeaf ? "bound" : "unresolved",
    });
  }
  for (const copy of registry?.copies ?? []) {
    if (copy.target.revisionId)
      await db.insert(activityRevisions).values({
        id: copy.target.revisionId,
        fileId: copy.target.id,
        identityId: copy.target.identityId,
        ownerAccountId: operation.ownerAccountId,
        eventId: event.id,
        previousRevisionId: copy.source.revisionId,
      });
    await db.insert(activityLineage).values({
      ownerAccountId: operation.ownerAccountId,
      eventId: event.id,
      sourceFileId: copy.source.id,
      sourceIdentityId: copy.source.identityId,
      targetFileId: copy.target.id,
      targetIdentityId: copy.target.identityId,
      kind: "copy",
      evidence: "server_confirmed",
    });
  }
  if (parent && registry?.file && ["archive.compress", "archive.extract"].includes(parent.action)) {
    const inputs = await db
      .select()
      .from(activityEventSubjects)
      .where(
        and(
          eq(activityEventSubjects.ownerAccountId, operation.ownerAccountId),
          eq(activityEventSubjects.eventId, parent.id),
          eq(activityEventSubjects.role, "affected"),
        ),
      );
    for (const input of inputs)
      if (input.fileId && input.fileId !== registry.file.id)
        await db.insert(activityLineage).values({
          ownerAccountId: operation.ownerAccountId,
          eventId: event.id,
          sourceFileId: input.fileId,
          sourceIdentityId: input.identityId,
          targetFileId: registry.file.id,
          targetIdentityId: registry.file.identityId,
          kind: parent.action === "archive.extract" ? "archive_member" : "derived",
          evidence: "server_confirmed",
        });
  }
  return event;
}

export function activityConditions(accountId: string, options: ActivityListOptions) {
  const e = activityEvents;
  return and(
    eq(e.ownerAccountId, accountId),
    options.identityId
      ? or(
          eq(e.identityId, options.identityId),
          sql`exists (select 1 from ${activityEventSubjects} s where s.owner_account_id = ${accountId} and s.event_id = ${e.id} and s.identity_id = ${options.identityId})`,
        )
      : undefined,
    options.action ? eq(e.action, options.action) : undefined,
    options.source ? eq(e.source, options.source) : undefined,
    options.outcome ? eq(e.outcome, options.outcome) : undefined,
    options.from ? gte(e.sortAt, options.from) : undefined,
    options.to ? lte(e.sortAt, options.to) : undefined,
    options.batchId ? eq(e.batchId, options.batchId) : undefined,
    options.snapshotSequence === undefined
      ? undefined
      : lte(e.ownerSequence, options.snapshotSequence),
    options.after
      ? or(
          lt(e.sortAt, options.after.at),
          and(eq(e.sortAt, options.after.at), lt(e.id, options.after.id)),
        )
      : undefined,
    options.fileId
      ? sql`exists (select 1 from ${activityEventSubjects} s where s.owner_account_id = ${accountId} and s.event_id = ${e.id} and s.file_id = ${options.fileId})`
      : undefined,
    options.q
      ? sql`exists (select 1 from ${activityEventSubjects} s where s.owner_account_id = ${accountId} and s.event_id = ${e.id} and s.virtual_path_snapshot ilike ${`%${escapeActivityLike(options.q)}%`})`
      : undefined,
  );
}

export function createActivityRepo(db: Db, clock: () => Date = () => new Date(), pathLockDb?: Db) {
  async function finishActivity(
    accountId: string,
    id: string,
    result: ActivityFinish,
    abandonedBefore?: Date,
  ) {
    return db.transaction(async (tx) => {
      const operation = (
        await tx
          .select()
          .from(activityOperations)
          .where(
            and(eq(activityOperations.id, id), eq(activityOperations.ownerAccountId, accountId)),
          )
          .for("update")
      )[0];
      if (!operation) throw new Error("Activity operation not found");
      if (
        abandonedBefore &&
        (operation.updatedAt >= abandonedBefore ||
          !["prepared", "running"].includes(operation.state))
      )
        return null;
      const final = operation.finalEventId
        ? (
            await tx
              .select()
              .from(activityEvents)
              .where(
                and(
                  eq(activityEvents.ownerAccountId, accountId),
                  eq(activityEvents.id, operation.finalEventId),
                ),
              )
              .limit(1)
          )[0]
        : undefined;
      if (final && !(final.outcome === "unknown" && result.outcome !== "unknown")) return final;
      await lockActivityRegistry(tx, operation.identityId);
      const event = await appendActivityOutcome(tx, operation, result, clock(), final?.id);
      await tx
        .update(activityOperations)
        .set({
          state:
            result.outcome === "success" || result.outcome === "skipped"
              ? "completed"
              : result.outcome === "cancelled"
                ? "cancelled"
                : result.outcome === "unknown"
                  ? "uncertain"
                  : "failed",
          finalEventId: event.id,
          updatedAt: clock(),
        })
        .where(eq(activityOperations.id, id));
      return event;
    });
  }
  return {
    /** Metadata producers share the event commit; callback repositories stay on this connection. */
    transaction<T>(work: (database: Db) => Promise<T>): Promise<T> {
      return db.transaction((tx) => work(tx as unknown as Db));
    },
    /** Hold before metadata locks so abandoned-operation recovery cannot race a commit. */
    async lockForCommit(accountId: string, operationId: string) {
      const [row] = await db
        .select()
        .from(activityOperations)
        .where(
          and(
            eq(activityOperations.ownerAccountId, accountId),
            eq(activityOperations.id, operationId),
          ),
        )
        .for("update");
      if (row?.state !== "running") throw new ActivityConflict("Operation is no longer running");
    },
    async resolveFile(accountId: string, identityId: string, path: string) {
      return (
        (
          await db
            .select({ id: activityFiles.id })
            .from(activityFiles)
            .where(
              and(
                eq(activityFiles.identityId, identityId),
                eq(activityFiles.path, path),
                inArray(activityFiles.state, ["live", "unknown"]),
                sql`(exists (select 1 from ${activityEventSubjects} s where s.owner_account_id = ${accountId} and s.file_id = ${activityFiles.id}) or exists (select 1 from ${activityReadWindows} w where w.owner_account_id = ${accountId} and w.file_id = ${activityFiles.id}))`,
              ),
            )
            .orderBy(desc(activityFiles.firstObservedAt))
            .limit(1)
        )[0]?.id ?? null
      );
    },
    async clientEvent(
      accountId: string,
      context: string,
      input: ClientActivityRequest,
      kind: "file" | "dir",
    ) {
      return db.transaction(async (tx) => {
        await captureActivityIdentity(tx, { accountId, identityId: input.identityId });
        await lockActivityRegistry(tx, input.identityId);
        const file = await ensureActivityFile(tx, input.identityId, input.path, kind, clock());
        return appendActivityEvent(
          tx,
          {
            accountId,
            identityId: input.identityId,
            action: input.action,
            source: "web",
            evidence: "client_reported",
            stage: "outcome",
            outcome: "unknown",
            idempotencyKey: `client:${context}:${input.requestId}`,
            fileId: file.id,
            occurredAt: new Date(input.at),
            after: { path: input.path, ...(input.shareId ? { shareId: input.shareId } : {}) },
            subjects: [activitySubject(file, "primary")],
          },
          clock(),
        );
      });
    },
    async withPathLock<T>(identityId: string, path: string, work: () => Promise<T>): Promise<T> {
      // Hold locks on a separate pool: work commits its intent and outcome using
      // the main pool, including before provider I/O. Sharing that pool deadlocks
      // when concurrent lock holders exhaust its connections.
      if (!pathLockDb) throw new Error("Activity path locks require a dedicated database pool");
      return pathLockDb.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["activity-path", identityId, path])},0))`,
        );
        return work();
      });
    },
    async begin(input: ActivityOperationInput) {
      ActivityFacts.parse(input.requested);
      if (input.before) ActivityFacts.parse(input.before);
      return db.transaction(async (tx) => {
        const identities = [
          ...new Set([
            input.identityId,
            ...(input.subjects ?? []).map((subject) => subject.identityId),
          ]),
        ].sort();
        for (const identityId of identities)
          await captureActivityIdentity(tx, { accountId: input.accountId, identityId });
        for (const identityId of identities) await lockActivityRegistry(tx, identityId);
        const prior = (
          await tx
            .select()
            .from(activityOperations)
            .where(
              and(
                eq(activityOperations.ownerAccountId, input.accountId),
                eq(activityOperations.identityId, input.identityId),
                eq(activityOperations.source, input.source),
                eq(activityOperations.producerOperationId, input.producerOperationId),
              ),
            )
            .limit(1)
        )[0];
        if (prior) {
          if (prior.requestDigest !== input.requestDigest)
            throw new ActivityConflict("Operation ID was already used with different input");
          return prior;
        }
        const now = clock();
        const file = input.before?.path
          ? await ensureActivityFile(
              tx,
              input.identityId,
              input.before.path,
              input.before.kind,
              now,
            )
          : null;
        const capturedSubjects = [];
        for (const subject of input.subjects ?? []) {
          const file = await ensureActivityFile(
            tx,
            subject.identityId,
            subject.path,
            subject.kind,
            now,
          );
          capturedSubjects.push({
            fileId: file?.id ?? null,
            identityId: subject.identityId,
            path: subject.path,
            role: "affected" as const,
            ordinal: capturedSubjects.length + 1,
            revisionId: file?.revisionId ?? null,
          });
        }
        const [operationRow] = await tx
          .insert(activityOperations)
          .values({
            ownerAccountId: input.accountId,
            actorAccountId: input.accountId,
            identityId: input.identityId,
            source: input.source,
            action: input.action,
            requested: input.requested,
            before: input.before ?? null,
            requestDigest: input.requestDigest,
            producerOperationId: input.producerOperationId,
            batchId: input.batchId ?? null,
            parentOperationId: input.parentOperationId ?? null,
            fileId: file?.id ?? null,
            fileGeneration: file?.generation ?? null,
            revisionId: file?.revisionId ?? null,
            state: "prepared",
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const operation = requireActivityRow(operationRow, "Activity operation was not inserted");
        await appendActivityEvent(
          tx,
          {
            accountId: input.accountId,
            identityId: input.identityId,
            action: input.action,
            source: input.source,
            stage: "intent",
            evidence: "server_confirmed",
            outcome: null,
            operationId: operation.id,
            producerOperationId: input.producerOperationId,
            ...(input.batchId ? { batchId: input.batchId } : {}),
            before: input.requested,
            idempotencyKey: `${input.source}:${operation.id}:intent`,
            subjects: [
              {
                fileId: file?.id ?? null,
                identityId: input.identityId,
                path: input.requested.path ?? null,
                role: "primary",
                ordinal: 0,
                revisionId: file?.revisionId ?? null,
              },
              ...capturedSubjects,
            ],
          },
          now,
        );
        return operation;
      });
    },
    async claim(accountId: string, id: string) {
      return (
        (
          await db
            .update(activityOperations)
            .set({ state: "running", updatedAt: clock() })
            .where(
              and(
                eq(activityOperations.id, id),
                eq(activityOperations.ownerAccountId, accountId),
                eq(activityOperations.state, "prepared"),
              ),
            )
            .returning()
        ).length === 1
      );
    },
    async heartbeat(accountId: string, id: string) {
      await db
        .update(activityOperations)
        .set({ updatedAt: clock() })
        .where(
          and(
            eq(activityOperations.id, id),
            eq(activityOperations.ownerAccountId, accountId),
            inArray(activityOperations.state, ["prepared", "running"]),
          ),
        );
    },
    async finish(accountId: string, id: string, result: ActivityFinish) {
      const event = requireActivityRow(
        await finishActivity(accountId, id, result),
        "Activity outcome was not recorded",
      );
      return event;
    },
    recoverAbandoned: finishActivity,
    async pending(before: Date, limit = 100) {
      return db
        .select()
        .from(activityOperations)
        .where(
          and(
            inArray(activityOperations.state, ["prepared", "running"]),
            ne(activityOperations.source, "native"),
            lt(activityOperations.updatedAt, before),
          ),
        )
        .orderBy(activityOperations.updatedAt)
        .limit(limit);
    },
    async list(accountId: string, options: ActivityListOptions = {}) {
      return db
        .select()
        .from(activityEvents)
        .where(activityConditions(accountId, options))
        .orderBy(
          sql`${activityEvents.sortAt} desc nulls last`,
          sql`${activityEvents.id} desc nulls last`,
        )
        .limit(Math.min(options.limit ?? 50, 100));
    },
    async event(accountId: string, id: string) {
      return (
        (
          await db
            .select()
            .from(activityEvents)
            .where(and(eq(activityEvents.ownerAccountId, accountId), eq(activityEvents.id, id)))
            .limit(1)
        )[0] ?? null
      );
    },
    async subjects(accountId: string, eventIds: readonly string[]) {
      if (!eventIds.length) return [];
      // Each event preview has at most 20 subjects; full membership is separately paged.
      const pages = await Promise.all(
        eventIds.map((id) =>
          db
            .select()
            .from(activityEventSubjects)
            .where(
              and(
                eq(activityEventSubjects.ownerAccountId, accountId),
                eq(activityEventSubjects.eventId, id),
              ),
            )
            .orderBy(activityEventSubjects.ordinal)
            .limit(21),
        ),
      );
      return pages.flat();
    },
    async subjectPage(accountId: string, eventId: string, after = -1) {
      return db
        .select()
        .from(activityEventSubjects)
        .where(
          and(
            eq(activityEventSubjects.ownerAccountId, accountId),
            eq(activityEventSubjects.eventId, eventId),
            sql`${activityEventSubjects.ordinal} > ${after}`,
          ),
        )
        .orderBy(activityEventSubjects.ordinal)
        .limit(100);
    },
    async file(accountId: string, fileId: string) {
      const subject = (
        await db
          .select()
          .from(activityEventSubjects)
          .innerJoin(activityEvents, eq(activityEvents.id, activityEventSubjects.eventId))
          .where(
            and(
              eq(activityEventSubjects.ownerAccountId, accountId),
              eq(activityEventSubjects.fileId, fileId),
            ),
          )
          .orderBy(
            sql`${activityEvents.sortAt} desc nulls last`,
            sql`${activityEvents.id} desc nulls last`,
          )
          .limit(1)
      )[0];
      if (!subject) {
        const window = (
          await db
            .select()
            .from(activityReadWindows)
            .where(
              and(
                eq(activityReadWindows.ownerAccountId, accountId),
                eq(activityReadWindows.fileId, fileId),
              ),
            )
            .orderBy(desc(activityReadWindows.lastAt))
            .limit(1)
        )[0];
        if (!window) return null;
        const [file] = await db
          .select()
          .from(activityFiles)
          .innerJoin(
            activityStorageIdentities,
            eq(activityStorageIdentities.identityId, activityFiles.identityId),
          )
          .where(eq(activityFiles.id, fileId));
        return file
          ? {
              file: file.activity_files,
              storage: file.activity_storage_identities,
              lastSubject: { path: window.path, revisionId: null },
              lastEvent: {
                after: { path: window.path },
                before: null,
                lastConfirmedAt: null,
                occurredAt: window.lastAt,
              },
            }
          : null;
      }
      const [file] = await db
        .select()
        .from(activityFiles)
        .innerJoin(
          activityStorageIdentities,
          eq(activityStorageIdentities.identityId, activityFiles.identityId),
        )
        .where(eq(activityFiles.id, fileId));
      return file
        ? {
            file: file.activity_files,
            storage: file.activity_storage_identities,
            lastSubject: subject.activity_event_subjects,
            lastEvent: subject.activity_events,
          }
        : null;
    },
    async stream(accountId: string, sequence: number, limit = 100) {
      return db
        .select({ id: activityOutbox.eventId, sequence: activityOutbox.ownerSequence })
        .from(activityOutbox)
        .where(
          and(
            eq(activityOutbox.ownerAccountId, accountId),
            sql`${activityOutbox.ownerSequence} > ${sequence}`,
          ),
        )
        .orderBy(activityOutbox.ownerSequence)
        .limit(limit);
    },
    async boundary(accountId: string) {
      return (
        (
          await db
            .select()
            .from(activityStreams)
            .where(eq(activityStreams.ownerAccountId, accountId))
        )[0] ?? null
      );
    },
    async completedChildren(accountId: string, operationId: string) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(activityOperations)
        .where(
          and(
            eq(activityOperations.ownerAccountId, accountId),
            eq(activityOperations.parentOperationId, operationId),
            eq(activityOperations.state, "completed"),
          ),
        );
      return rows[0]?.count ?? 0;
    },
    async locations(accountId: string) {
      return db
        .selectDistinct({
          identityId: activityStorageIdentities.identityId,
          label: activityStorageIdentities.label,
        })
        .from(activityStorageIdentities)
        .where(
          sql`exists (select 1 from ${activityEventSubjects} where ${activityEventSubjects.identityId} = ${activityStorageIdentities.identityId} and ${activityEventSubjects.ownerAccountId} = ${accountId}) or exists (select 1 from ${activityEvents} where ${activityEvents.identityId} = ${activityStorageIdentities.identityId} and ${activityEvents.ownerAccountId} = ${accountId}) or exists (select 1 from ${activityReadWindows} where ${activityReadWindows.identityId} = ${activityStorageIdentities.identityId} and ${activityReadWindows.ownerAccountId} = ${accountId})`,
        )
        .limit(1000);
    },
    async batchSummary(accountId: string, batchId: string) {
      const result = await db.execute(sql`with latest as (
        select distinct on (operation_id) outcome from ${activityEvents}
        where owner_account_id = ${accountId} and batch_id = ${batchId} and operation_id is not null
        order by operation_id, owner_sequence desc
      ) select coalesce(outcome, 'pending') as outcome, count(*)::int as count from latest group by outcome`);
      const outcomes = Object.fromEntries(result.rows.map((row) => [row.outcome, row.count]));
      return ActivityBatchSummary.parse({
        total: result.rows.reduce((sum, row) => sum + Number(row.count), 0),
        outcomes,
      });
    },
    async lineage(accountId: string, fileId: string, afterId?: string) {
      return db
        .select()
        .from(activityLineage)
        .where(
          and(
            eq(activityLineage.ownerAccountId, accountId),
            or(eq(activityLineage.sourceFileId, fileId), eq(activityLineage.targetFileId, fileId)),
            afterId ? sql`${activityLineage.id} > ${afterId}` : undefined,
          ),
        )
        .orderBy(activityLineage.id)
        .limit(100);
    },
    async revisions(accountId: string, fileId: string, afterId?: string) {
      return db
        .select()
        .from(activityRevisions)
        .where(
          and(
            eq(activityRevisions.ownerAccountId, accountId),
            eq(activityRevisions.fileId, fileId),
            afterId ? sql`${activityRevisions.id} > ${afterId}` : undefined,
          ),
        )
        .orderBy(activityRevisions.id)
        .limit(100);
    },
  };
}
export type ActivityRepo = ReturnType<typeof createActivityRepo>;
