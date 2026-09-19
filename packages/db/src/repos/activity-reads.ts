import type {
  PersonalActivityAction,
  PersonalActivityEvidence,
  PersonalActivityOutcome,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import {
  activityEvents,
  activityFiles,
  activityReadReceipts,
  activityReadWindows,
} from "../schema/activity.js";
import { ensureActivityFile, lockActivityRegistry } from "./activity-registry.js";
import type { ActivityActor } from "./activity-types.js";
import { ActivityConflict, requireActivityRow } from "./activity-types.js";
import { appendActivityEvent, captureActivityIdentity } from "./activity-writer.js";

export const AGGREGATED_ACTIVITY_READS: ReadonlySet<PersonalActivityAction> = new Set([
  "file.open",
  "file.preview",
  "file.inspect",
  "file.read",
  "file.reveal",
  "archive.inspect",
]);
export interface ActivityReadInput extends ActivityActor {
  path: string;
  kind: "file" | "dir";
  action: PersonalActivityAction;
  source: PersonalActivitySource;
  evidence: PersonalActivityEvidence;
  contextHash: string;
  requestId: string;
  at: Date;
  outcome: PersonalActivityOutcome;
}
export function createActivityReadsRepo(db: Db, clock: () => Date = () => new Date()) {
  return {
    async record(input: ActivityReadInput) {
      const now = clock();
      if (!AGGREGATED_ACTIVITY_READS.has(input.action)) throw Error("Not an aggregate read action");
      if (
        !Number.isFinite(input.at.getTime()) ||
        input.at.getTime() < now.getTime() - 600_000 ||
        input.at.getTime() > now.getTime() + 60_000
      )
        throw Error("Activity report expired");
      return db.transaction(async (tx) => {
        await captureActivityIdentity(tx, input);
        await lockActivityRegistry(tx, input.identityId);
        const receipt = (
          await tx
            .select()
            .from(activityReadReceipts)
            .where(
              and(
                eq(activityReadReceipts.ownerAccountId, input.accountId),
                eq(activityReadReceipts.identityId, input.identityId),
                eq(activityReadReceipts.contextHash, input.contextHash),
                eq(activityReadReceipts.requestId, input.requestId),
              ),
            )
            .limit(1)
        )[0];
        if (receipt) {
          const window = (
            await tx
              .select()
              .from(activityReadWindows)
              .where(eq(activityReadWindows.id, receipt.windowId))
              .for("update")
          )[0];
          if (
            !window ||
            window.path !== input.path ||
            window.action !== input.action ||
            window.source !== input.source
          )
            throw new ActivityConflict("Read request ID was reused");
          if (
            receipt.outcome === "unknown" &&
            input.outcome !== "unknown" &&
            input.evidence === "server_confirmed"
          ) {
            if (window.sealedAt) {
              await appendActivityEvent(
                tx,
                {
                  accountId: input.accountId,
                  identityId: input.identityId,
                  action: input.action,
                  source: input.source,
                  evidence: "reconciled",
                  stage: "reconciliation",
                  outcome: input.outcome,
                  parentEventId: window.id,
                  fileId: window.fileId,
                  idempotencyKey: `read-correction:${input.contextHash}:${input.requestId}`,
                  after: { path: window.path },
                  subjects: [
                    {
                      fileId: window.fileId,
                      identityId: input.identityId,
                      role: "primary",
                      ordinal: 0,
                      path: window.path,
                      revisionId: null,
                    },
                  ],
                },
                now,
              );
            } else {
              const counts = {
                ...window.outcomeCounts,
                unknown: Math.max(0, (window.outcomeCounts.unknown ?? 0) - 1),
                [input.outcome]: (window.outcomeCounts[input.outcome] ?? 0) + 1,
              };
              await tx
                .update(activityReadWindows)
                .set({ outcomeCounts: counts })
                .where(eq(activityReadWindows.id, window.id));
            }
            await tx
              .update(activityReadReceipts)
              .set({ outcome: input.outcome })
              .where(
                and(
                  eq(activityReadReceipts.ownerAccountId, input.accountId),
                  eq(activityReadReceipts.identityId, input.identityId),
                  eq(activityReadReceipts.contextHash, input.contextHash),
                  eq(activityReadReceipts.requestId, input.requestId),
                ),
              );
          }
          return receipt.windowId;
        }
        const file = await ensureActivityFile(tx, input.identityId, input.path, input.kind, now);
        // Admission-time UTC buckets allow delayed reports without reopening sealed history.
        // The original first/last gesture times are retained separately.
        const bucketStart = new Date(Math.floor(now.getTime() / 300_000) * 300_000);
        const [windowRow] = await tx
          .insert(activityReadWindows)
          .values({
            ownerAccountId: input.accountId,
            identityId: input.identityId,
            fileId: file.id,
            action: input.action,
            source: input.source,
            evidence: input.evidence,
            contextHash: input.contextHash,
            generation: file.generation,
            bucketStart,
            path: input.path,
            firstAt: input.at,
            lastAt: input.at,
            count: 1,
            outcomeCounts: { [input.outcome]: 1 },
          })
          .onConflictDoUpdate({
            target: [
              activityReadWindows.ownerAccountId,
              activityReadWindows.identityId,
              activityReadWindows.fileId,
              activityReadWindows.action,
              activityReadWindows.source,
              activityReadWindows.contextHash,
              activityReadWindows.generation,
              activityReadWindows.bucketStart,
            ],
            set: {
              count: sql`${activityReadWindows.count} + 1`,
              firstAt: sql`least(${activityReadWindows.firstAt}, ${input.at})`,
              lastAt: sql`greatest(${activityReadWindows.lastAt}, ${input.at})`,
              outcomeCounts: sql`jsonb_set(${activityReadWindows.outcomeCounts}, array[${input.outcome}::text], to_jsonb(coalesce((${activityReadWindows.outcomeCounts}->>${input.outcome})::int,0)+1))`,
            },
          })
          .returning();
        const window = requireActivityRow(windowRow, "Read window was not stored");
        await tx.insert(activityReadReceipts).values({
          ownerAccountId: input.accountId,
          identityId: input.identityId,
          contextHash: input.contextHash,
          requestId: input.requestId,
          windowId: window.id,
          outcome: input.outcome,
          expiresAt: new Date(now.getTime() + 86_400_000),
        });
        return window.id;
      });
    },
    async seal(limit = 100) {
      return db.transaction(async (tx) => {
        const now = clock();
        const windows = await tx
          .select()
          .from(activityReadWindows)
          .where(
            and(
              isNull(activityReadWindows.sealedAt),
              lt(activityReadWindows.bucketStart, new Date(now.getTime() - 360_000)),
            ),
          )
          .orderBy(activityReadWindows.bucketStart)
          .limit(limit)
          .for("update", { skipLocked: true });
        for (const window of windows) {
          const outcomes = Object.entries(window.outcomeCounts).filter(([, count]) => count > 0);
          const outcome =
            outcomes.length === 1 ? (outcomes[0]?.[0] as PersonalActivityOutcome) : "partial";
          await appendActivityEvent(
            tx,
            {
              id: window.id,
              accountId: window.ownerAccountId,
              identityId: window.identityId,
              action: window.action,
              source: window.source,
              evidence: window.evidence,
              stage: "outcome",
              outcome: outcome ?? "unknown",
              idempotencyKey: `read:${window.id}`,
              fileId: window.fileId,
              occurredAt: window.lastAt,
              count: window.count,
              firstAt: window.firstAt,
              lastAt: window.lastAt,
              outcomeCounts: window.outcomeCounts,
              after: { path: window.path },
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
            },
            now,
          );
          await tx
            .update(activityReadWindows)
            .set({ sealedAt: now })
            .where(eq(activityReadWindows.id, window.id));
        }
        await tx.delete(activityReadReceipts).where(lt(activityReadReceipts.expiresAt, now));
        return windows.length;
      });
    },
    async provisional(accountId: string, identityId?: string) {
      return db
        .select()
        .from(activityReadWindows)
        .where(
          and(
            eq(activityReadWindows.ownerAccountId, accountId),
            isNull(activityReadWindows.sealedAt),
            identityId ? eq(activityReadWindows.identityId, identityId) : undefined,
          ),
        )
        .orderBy(desc(activityReadWindows.lastAt))
        .limit(100);
    },
    async recents(accountId: string, identityId: string) {
      const latest = sql<Date>`max(${activityEvents.sortAt})`.mapWith(activityEvents.sortAt);
      const rows = await db
        .select({ path: activityFiles.path, at: latest })
        .from(activityEvents)
        .innerJoin(activityFiles, eq(activityFiles.id, activityEvents.fileId))
        .where(
          and(
            eq(activityEvents.ownerAccountId, accountId),
            eq(activityEvents.identityId, identityId),
            eq(activityEvents.action, "file.open"),
            eq(activityFiles.state, "live"),
          ),
        )
        .groupBy(activityFiles.path)
        .orderBy(desc(latest))
        .limit(100);
      const latestRead = sql<Date>`max(${activityReadWindows.lastAt})`.mapWith(
        activityReadWindows.lastAt,
      );
      const windows = await db
        .select({ path: activityFiles.path, at: latestRead })
        .from(activityReadWindows)
        .innerJoin(activityFiles, eq(activityFiles.id, activityReadWindows.fileId))
        .where(
          and(
            eq(activityReadWindows.ownerAccountId, accountId),
            eq(activityReadWindows.identityId, identityId),
            eq(activityReadWindows.action, "file.open"),
            isNull(activityReadWindows.sealedAt),
            eq(activityFiles.state, "live"),
          ),
        )
        .groupBy(activityFiles.path)
        .orderBy(desc(latestRead))
        .limit(100);
      const values = [...rows, ...windows].sort((a, b) => b.at.getTime() - a.at.getTime());
      const paths = new Map<string, Date>();
      for (const row of values) if (row.path && !paths.has(row.path)) paths.set(row.path, row.at);
      return [...paths].slice(0, 100).map(([path, openedAt]) => ({ path, openedAt }));
    },
  };
}
export type ActivityReadsRepo = ReturnType<typeof createActivityReadsRepo>;
