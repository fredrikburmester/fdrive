import { createHash } from "node:crypto";
import type {
  ActivityFacts,
  PersonalActivityAction,
  PersonalActivityEvidence,
} from "@fdrive/contracts";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import {
  activityEventSubjects,
  activityFileLocations,
  activityFiles,
  activityObservationState,
  activityOperations,
  activityReadWindows,
} from "../schema/activity.js";
import {
  activityFingerprint,
  activitySubject,
  ensureActivityFile,
  escapeActivityLike,
  lockActivityRegistry,
} from "./activity-registry.js";
import { appendActivityEvent, captureActivityIdentity } from "./activity-writer.js";

export interface ActivityObservationInput {
  accountId: string;
  identityId: string;
  path: string;
  kind: "present" | "missing" | "moved" | "left_scope" | "continuity_unknown";
  source: "indexer" | "refresh";
  evidence: PersonalActivityEvidence;
  after?: ActivityFacts;
}
export function createActivityObservationsRepo(db: Db, clock: () => Date = () => new Date()) {
  const owned = (accountId: string) =>
    sql`(exists (select 1 from ${activityEventSubjects} s where s.owner_account_id = ${accountId} and s.file_id = ${activityFiles.id}) or exists (select 1 from ${activityReadWindows} w where w.owner_account_id = ${accountId} and w.file_id = ${activityFiles.id}))`;
  return {
    async tracked(accountId: string, identityId: string, path: string, afterId?: string) {
      return db
        .select()
        .from(activityFiles)
        .where(
          and(
            eq(activityFiles.identityId, identityId),
            inArray(activityFiles.state, ["live", "unknown"]),
            or(
              eq(activityFiles.path, path),
              like(activityFiles.path, `${escapeActivityLike(path)}/%`),
            ),
            owned(accountId),
            afterId ? sql`${activityFiles.id} > ${afterId}` : undefined,
          ),
        )
        .orderBy(activityFiles.id)
        .limit(100);
    },
    async children(accountId: string, identityId: string, parent: string, afterId?: string) {
      const prefix = parent === "/" ? "/" : `${parent}/`;
      return db
        .select()
        .from(activityFiles)
        .where(
          and(
            eq(activityFiles.identityId, identityId),
            inArray(activityFiles.state, ["live", "unknown"]),
            like(activityFiles.path, `${escapeActivityLike(prefix)}%`),
            sql`position('/' in substring(${activityFiles.path} from ${prefix.length + 1}::int)) = 0`,
            owned(accountId),
            afterId ? sql`${activityFiles.id} > ${afterId}` : undefined,
          ),
        )
        .orderBy(activityFiles.id)
        .limit(100);
    },
    async observe(input: ActivityObservationInput) {
      return db.transaction(async (tx) => {
        await captureActivityIdentity(tx, input);
        await lockActivityRegistry(tx, input.identityId);
        const file = (
          await tx
            .select()
            .from(activityFiles)
            .where(
              and(
                eq(activityFiles.identityId, input.identityId),
                eq(activityFiles.path, input.path),
                inArray(activityFiles.state, ["live", "unknown"]),
                owned(input.accountId),
              ),
            )
            .orderBy(
              sql`case when ${activityFiles.state} = 'live' then 0 else 1 end`,
              activityFiles.firstObservedAt,
            )
            .limit(1)
        )[0];
        if (!file) return null;
        // Notifications can arrive during I/O. The intent owns that uncertainty;
        // refresh will retry comparison after the operation settles.
        const pending = (
          await tx
            .select({ id: activityOperations.id })
            .from(activityOperations)
            .where(
              and(
                eq(activityOperations.identityId, input.identityId),
                inArray(activityOperations.state, ["prepared", "running"]),
                or(
                  eq(activityOperations.fileId, file.id),
                  // A directory operation owns uncertainty for its descendants
                  // too. Literal prefix comparison keeps %, _ and backslashes
                  // in file names from turning into SQL wildcard matches.
                  sql`exists (
                    select 1 from (values
                      (${activityOperations.requested}->>'path'),
                      (${activityOperations.requested}->>'targetPath')
                    ) as pending(path)
                    where ${input.path} = pending.path
                      or starts_with(${input.path}, rtrim(pending.path, '/') || '/')
                      or ${input.after?.path ?? null} = pending.path
                      or starts_with(${input.after?.path ?? null}, rtrim(pending.path, '/') || '/')
                  )`,
                ),
              ),
            )
            .limit(1)
        )[0];
        if (pending) return null;
        const now = clock();
        const fingerprint = input.after ? activityFingerprint(input.after) : null;
        const unresolved = (
          await tx
            .select()
            .from(activityObservationState)
            .where(
              and(
                eq(activityObservationState.ownerAccountId, input.accountId),
                eq(activityObservationState.fileId, file.id),
                inArray(activityObservationState.discrepancy, [
                  "observation.location_missing",
                  "observation.left_scope",
                  "observation.continuity_unknown",
                ]),
                isNull(activityObservationState.resolvedEventId),
              ),
            )
            .limit(1)
        )[0];
        let action: PersonalActivityAction;
        if (input.kind === "present") {
          if (unresolved && file.state === "unknown") action = "observation.resolved";
          else if (
            fingerprint &&
            file.fingerprint &&
            fingerprint.split(":", 1)[0] === file.fingerprint.split(":", 1)[0] &&
            fingerprint !== file.fingerprint
          )
            action = "observation.content_changed";
          else {
            await tx
              .update(activityFiles)
              .set({ fingerprint: fingerprint ?? file.fingerprint, lastConfirmedAt: now })
              .where(eq(activityFiles.id, file.id));
            return null;
          }
        } else
          action =
            input.kind === "moved"
              ? "observation.location_changed"
              : input.kind === "left_scope"
                ? "observation.left_scope"
                : input.kind === "continuity_unknown"
                  ? "observation.continuity_unknown"
                  : "observation.location_missing";
        const target = input.kind === "moved" ? input.after?.path : undefined;
        const occupied =
          target && target !== file.path
            ? (
                await tx
                  .select({ id: activityFiles.id })
                  .from(activityFiles)
                  .where(
                    and(
                      eq(activityFiles.identityId, input.identityId),
                      eq(activityFiles.path, target),
                      eq(activityFiles.state, "live"),
                    ),
                  )
                  .limit(1)
              )[0]
            : undefined;
        if (occupied) action = "observation.continuity_unknown";
        const evidenceKey = createHash("sha256")
          .update(JSON.stringify([action, file.generation, input.after ?? null]))
          .digest("hex");
        const prior = (
          await tx
            .select()
            .from(activityObservationState)
            .where(
              and(
                eq(activityObservationState.ownerAccountId, input.accountId),
                eq(activityObservationState.fileId, file.id),
                eq(activityObservationState.generation, file.generation),
                eq(activityObservationState.discrepancy, action),
              ),
            )
        )[0];
        if (prior?.fingerprint === evidenceKey) return null;
        // Rediscovery resolves the location gap, not identity continuity. A
        // same-path replacement gets a new UUID; the old journey stays unknown.
        const rediscovered =
          action === "observation.resolved"
            ? await ensureActivityFile(
                tx,
                input.identityId,
                input.path,
                input.after?.kind ?? file.kind,
                now,
              )
            : null;
        const event = await appendActivityEvent(
          tx,
          {
            accountId: input.accountId,
            identityId: input.identityId,
            action,
            source: input.source,
            evidence: input.evidence,
            stage: action === "observation.resolved" ? "reconciliation" : "outcome",
            outcome: "unknown",
            fileId: file.id,
            idempotencyKey: `observation:${file.id}:${evidenceKey}`,
            occurredAt: null,
            lastConfirmedAt: file.lastConfirmedAt,
            detectedAt: now,
            before: { path: file.path, kind: file.kind },
            ...(input.after ? { after: input.after } : {}),
            ...(unresolved?.eventId && action === "observation.resolved"
              ? { parentEventId: unresolved.eventId }
              : {}),
            subjects: [
              activitySubject(file, "primary"),
              ...(rediscovered ? [activitySubject(rediscovered, "target", 1)] : []),
            ],
          },
          now,
        );
        await tx
          .insert(activityObservationState)
          .values({
            ownerAccountId: input.accountId,
            identityId: input.identityId,
            fileId: file.id,
            generation: file.generation,
            discrepancy: action,
            fingerprint: evidenceKey,
            eventId: event.id,
            lastCheckAt: now,
            lastConfirmedAt: file.lastConfirmedAt,
            detectedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              activityObservationState.ownerAccountId,
              activityObservationState.identityId,
              activityObservationState.fileId,
              activityObservationState.generation,
              activityObservationState.discrepancy,
            ],
            set: {
              fingerprint: evidenceKey,
              eventId: event.id,
              lastCheckAt: now,
              resolvedEventId: null,
            },
          });
        if (action === "observation.resolved" && unresolved)
          await tx
            .update(activityObservationState)
            .set({ resolvedEventId: event.id })
            .where(
              and(
                eq(activityObservationState.ownerAccountId, input.accountId),
                eq(activityObservationState.fileId, file.id),
                inArray(activityObservationState.discrepancy, [
                  "observation.location_missing",
                  "observation.left_scope",
                  "observation.continuity_unknown",
                ]),
                isNull(activityObservationState.resolvedEventId),
              ),
            );
        if (rediscovered) return event;
        if (target && target !== file.path) {
          if (!occupied) {
            await tx
              .update(activityFileLocations)
              .set({ validUntil: now })
              .where(
                and(
                  eq(activityFileLocations.fileId, file.id),
                  isNull(activityFileLocations.validUntil),
                ),
              );
            await tx.insert(activityFileLocations).values({
              fileId: file.id,
              identityId: file.identityId,
              path: target,
              validFrom: now,
              generation: file.generation + 1,
            });
            await tx
              .update(activityFiles)
              .set({
                path: target,
                state: "live",
                generation: file.generation + 1,
                fingerprint,
                lastConfirmedAt: now,
              })
              .where(eq(activityFiles.id, file.id));
          } else
            await tx
              .update(activityFiles)
              .set({ state: "unknown" })
              .where(eq(activityFiles.id, file.id));
          // An occupied destination remains an unmerged branch. Never merge by hash.
        } else if (["missing", "left_scope", "continuity_unknown"].includes(input.kind))
          await tx
            .update(activityFiles)
            .set({ state: "unknown" })
            .where(eq(activityFiles.id, file.id));
        else
          await tx
            .update(activityFiles)
            .set({
              state: "live",
              generation: file.generation + 1,
              fingerprint: fingerprint ?? file.fingerprint,
              lastConfirmedAt: now,
            })
            .where(eq(activityFiles.id, file.id));
        return event;
      });
    },
  };
}
export type ActivityObservationsRepo = ReturnType<typeof createActivityObservationsRepo>;
