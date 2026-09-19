import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import {
  activityEvents,
  activityExportReads,
  activityExports,
  activityLineage,
  activityReadWindows,
  activityRevisions,
  activityStreams,
} from "../schema/activity.js";
import { activityConditions } from "./activity.js";
import type { ActivityListOptions } from "./activity-types.js";
import { requireActivityRow } from "./activity-types.js";

/** An immutable sequence snapshot. Downloads stream pages, never a million-row array. */
export function createActivityExportsRepo(db: Db, clock: () => Date = () => new Date()) {
  return {
    async create(accountId: string, format: "json" | "csv", filters: Record<string, string>) {
      return db.transaction(async (tx) => {
        await tx
          .insert(activityStreams)
          .values({ ownerAccountId: accountId, historyStartsAt: clock() })
          .onConflictDoNothing();
        const [streamRow] = await tx
          .select()
          .from(activityStreams)
          .where(eq(activityStreams.ownerAccountId, accountId))
          .for("update");
        const stream = requireActivityRow(streamRow, "Activity boundary unavailable");
        const [snapshotRow] = await tx
          .insert(activityExports)
          .values({
            ownerAccountId: accountId,
            format,
            filters,
            snapshotSequence: stream.nextSequence - 1,
            state: "completed",
            createdAt: clock(),
            expiresAt: new Date(clock().getTime() + 86_400_000),
          })
          .returning();
        const snapshot = requireActivityRow(snapshotRow, "Activity export was not created");
        // One SQL snapshot, no open-window count limit or mutable history reference.
        // The stream lock prevents the sealer publishing one of these windows below our cutoff.
        await tx.execute(sql`insert into ${activityExportReads} (export_id, owner_account_id, window_id, payload)
          select ${snapshot.id}, w.owner_account_id, w.id, jsonb_build_object(
            'id', w.id, 'ownerAccountId', w.owner_account_id, 'identityId', w.identity_id,
            'fileId', w.file_id, 'action', w.action, 'source', w.source, 'contextHash', w.context_hash,
            'evidence', w.evidence, 'generation', w.file_generation, 'bucketStart', w.bucket_start,
            'path', w.virtual_path, 'firstAt', w.first_at, 'lastAt', w.last_at,
            'count', w.attempted_count, 'outcomeCounts', w.outcome_counts, 'sealedAt', null)
          from ${activityReadWindows} w where w.owner_account_id = ${accountId} and w.sealed_at is null`);
        return snapshot;
      });
    },
    async get(accountId: string, id: string) {
      return (
        (
          await db
            .select()
            .from(activityExports)
            .where(
              and(
                eq(activityExports.ownerAccountId, accountId),
                eq(activityExports.id, id),
                sql`${activityExports.expiresAt} > ${clock()}`,
              ),
            )
            .limit(1)
        )[0] ?? null
      );
    },
    async reads(accountId: string, exportId: string, afterId?: string) {
      return db
        .select()
        .from(activityExportReads)
        .where(
          and(
            eq(activityExportReads.ownerAccountId, accountId),
            eq(activityExportReads.exportId, exportId),
            afterId ? sql`${activityExportReads.windowId} > ${afterId}` : undefined,
          ),
        )
        .orderBy(activityExportReads.windowId)
        .limit(100);
    },
    async lineage(
      accountId: string,
      sequence: number,
      afterId?: string,
      filters: ActivityListOptions = {},
    ) {
      return db
        .select({ edge: activityLineage })
        .from(activityLineage)
        .innerJoin(
          activityEvents,
          and(
            eq(activityEvents.id, activityLineage.eventId),
            eq(activityEvents.ownerAccountId, accountId),
          ),
        )
        .where(
          and(
            eq(activityLineage.ownerAccountId, accountId),
            lte(activityEvents.ownerSequence, sequence),
            activityConditions(accountId, filters),
            afterId ? sql`${activityLineage.id} > ${afterId}` : undefined,
          ),
        )
        .orderBy(activityLineage.id)
        .limit(100);
    },
    async revisions(
      accountId: string,
      sequence: number,
      afterId?: string,
      filters: ActivityListOptions = {},
    ) {
      return db
        .select({ revision: activityRevisions })
        .from(activityRevisions)
        .innerJoin(
          activityEvents,
          and(
            eq(activityEvents.id, activityRevisions.eventId),
            eq(activityEvents.ownerAccountId, accountId),
          ),
        )
        .where(
          and(
            eq(activityRevisions.ownerAccountId, accountId),
            lte(activityEvents.ownerSequence, sequence),
            activityConditions(accountId, filters),
            afterId ? sql`${activityRevisions.id} > ${afterId}` : undefined,
          ),
        )
        .orderBy(activityRevisions.id)
        .limit(100);
    },
  };
}
export type ActivityExportsRepo = ReturnType<typeof createActivityExportsRepo>;
