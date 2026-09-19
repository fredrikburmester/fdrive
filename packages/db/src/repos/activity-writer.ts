import { randomUUID } from "node:crypto";
import { ActivityFacts } from "@fdrive/contracts";
import { and, eq, sql } from "drizzle-orm";
import {
  activityEventSubjects,
  activityEvents,
  activityOutbox,
  activityStorageIdentities,
  activityStreams,
} from "../schema/activity.js";
import type {
  ActivityActor,
  ActivityAppend,
  ActivityDb,
  ActivityEventRecord,
} from "./activity-types.js";
import { requireActivityRow } from "./activity-types.js";

/** Lock ordering: live identity, file registry, then account stream at append. */
export async function captureActivityIdentity(db: ActivityDb, actor: ActivityActor): Promise<void> {
  const result = await db.execute(sql`select i.id, i.account_id, i.provider_id, p.type, p.label
    from app.identities i join app.providers p on p.id = i.provider_id where i.id = ${actor.identityId} for update of i`);
  const row = result.rows[0];
  if (!row || row.account_id !== actor.accountId) throw new Error("Identity ownership changed");
  await db
    .insert(activityStorageIdentities)
    .values({
      identityId: actor.identityId,
      providerId: String(row.provider_id),
      providerType: String(row.type),
      label: String(row.label),
    })
    .onConflictDoNothing();
}

/** Per-owner sequence is allocated in the event transaction; commits cannot leave SSE holes. */
export async function appendActivityEvent(
  db: ActivityDb,
  input: ActivityAppend,
  now = new Date(),
): Promise<ActivityEventRecord> {
  const facts = [input.before, input.after, input.detail].map((value) =>
    value === undefined ? null : ActivityFacts.parse(value),
  );
  if (Buffer.byteLength(JSON.stringify(facts)) > 16384)
    throw new Error("Activity payload exceeds 16 KiB");
  await db
    .insert(activityStreams)
    .values({ ownerAccountId: input.accountId, historyStartsAt: now })
    .onConflictDoNothing();
  await db.execute(
    sql`select owner_account_id from ${activityStreams} where owner_account_id = ${input.accountId} for update`,
  );
  const existing = await db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.ownerAccountId, input.accountId),
        eq(activityEvents.identityId, input.identityId),
        eq(activityEvents.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const [streamRow] = await db
    .update(activityStreams)
    .set({ nextSequence: sql`${activityStreams.nextSequence} + 1` })
    .where(eq(activityStreams.ownerAccountId, input.accountId))
    .returning();
  const stream = requireActivityRow(streamRow, "Activity stream disappeared");
  const observed = input.action.startsWith("observation.");
  const occurredAt = input.occurredAt === undefined ? now : input.occurredAt;
  const [eventRow] = await db
    .insert(activityEvents)
    .values({
      id: input.id ?? randomUUID(),
      ownerAccountId: input.accountId,
      ownerSequence: stream.nextSequence - 1,
      actorAccountId: observed ? null : input.accountId,
      identityId: input.identityId,
      fileId: input.fileId ?? null,
      class: observed ? "observation" : "action",
      action: input.action,
      stage: input.stage,
      outcome: input.outcome,
      source: input.source,
      evidence: input.evidence,
      operationId: input.operationId ?? null,
      producerOperationId: input.producerOperationId ?? null,
      batchId: input.batchId ?? null,
      parentEventId: input.parentEventId ?? null,
      occurredAt,
      recordedAt: now,
      sortAt: occurredAt ?? input.detectedAt ?? now,
      lastConfirmedAt: input.lastConfirmedAt ?? null,
      detectedAt: input.detectedAt ?? null,
      before: facts[0] ?? null,
      after: facts[1] ?? null,
      detail: facts[2] ?? null,
      errorCode: input.errorCode ?? null,
      count: input.count ?? 1,
      firstAt: input.firstAt ?? null,
      lastAt: input.lastAt ?? null,
      outcomeCounts: input.outcomeCounts ?? null,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  const event = requireActivityRow(eventRow, "Activity event was not inserted");
  const allSubjects = input.subjects ?? [];
  for (let offset = 0; offset < allSubjects.length; offset += 100) {
    const subjects = allSubjects.slice(offset, offset + 100);
    await db.insert(activityEventSubjects).values(
      subjects.map((subject, index) => ({
        ownerAccountId: input.accountId,
        eventId: event.id,
        identityId: subject.identityId,
        fileId: subject.fileId,
        role: subject.role,
        // One ordering across roles, so a page boundary never skips a source
        // and target that arrived with the same producer-local ordinal.
        ordinal: offset + index,
        path: subject.path,
        revisionId: subject.revisionId,
      })),
    );
  }
  await db.insert(activityOutbox).values({
    eventId: event.id,
    ownerAccountId: input.accountId,
    ownerSequence: event.ownerSequence,
    availableAt: now,
  });
  return event;
}
