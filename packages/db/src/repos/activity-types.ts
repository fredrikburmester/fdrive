import type {
  ActivityFacts,
  ActivitySubject,
  PersonalActivityAction,
  PersonalActivityEvidence,
  PersonalActivityOutcome,
  PersonalActivitySource,
} from "@fdrive/contracts";
import type { Db } from "../index.js";
import type { activityEvents, activityFiles, activityOperations } from "../schema/activity.js";

export type ActivityDb = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

/**
 * Narrows a row that the preceding insert, update or locked select must have produced.
 * Keeping the check here means each call site stays a single reachable statement.
 */
export function requireActivityRow<T>(row: T | undefined | null, message: string): T {
  if (!row) throw new Error(message);
  return row;
}
export type ActivityEventRecord = typeof activityEvents.$inferSelect;
export type ActivityFileRecord = typeof activityFiles.$inferSelect;
export type ActivityOperationRecord = typeof activityOperations.$inferSelect;
export interface ActivityActor {
  readonly accountId: string;
  readonly identityId: string;
}
export interface ActivityOperationInput extends ActivityActor {
  readonly action: PersonalActivityAction;
  readonly source: PersonalActivitySource;
  readonly producerOperationId: string;
  readonly batchId?: string;
  readonly parentOperationId?: string;
  readonly requested: ActivityFacts;
  readonly before?: ActivityFacts;
  readonly requestDigest: string;
  readonly subjects?: readonly { identityId: string; path: string; kind?: "file" | "dir" }[];
}
export interface ActivityAppend extends ActivityActor {
  readonly id?: string;
  readonly action: PersonalActivityAction;
  readonly source: PersonalActivitySource;
  readonly evidence: PersonalActivityEvidence;
  readonly stage: "intent" | "outcome" | "reconciliation";
  readonly outcome: PersonalActivityOutcome | null;
  readonly idempotencyKey: string;
  readonly operationId?: string;
  readonly producerOperationId?: string;
  readonly batchId?: string;
  readonly parentEventId?: string;
  readonly fileId?: string;
  readonly occurredAt?: Date | null;
  readonly detectedAt?: Date;
  readonly lastConfirmedAt?: Date;
  readonly before?: ActivityFacts;
  readonly after?: ActivityFacts;
  readonly detail?: ActivityFacts;
  readonly errorCode?: string;
  readonly count?: number;
  readonly firstAt?: Date;
  readonly lastAt?: Date;
  readonly outcomeCounts?: Partial<Record<PersonalActivityOutcome, number>>;
  readonly subjects?: readonly ActivitySubject[];
}
export interface ActivityFinish {
  readonly outcome: PersonalActivityOutcome;
  readonly before?: ActivityFacts;
  readonly subjects?: readonly ActivitySubject[];
  readonly after?: ActivityFacts;
  readonly detail?: ActivityFacts;
  readonly errorCode?: string;
  readonly at?: Date;
  readonly bridge?: { namespace: "office" | "desktop" | "provider"; externalId: string };
}
export interface ActivityListOptions {
  readonly identityId?: string;
  readonly action?: PersonalActivityAction;
  readonly source?: PersonalActivitySource;
  readonly outcome?: PersonalActivityOutcome;
  readonly from?: Date;
  readonly to?: Date;
  readonly q?: string;
  readonly fileId?: string;
  readonly batchId?: string;
  readonly limit?: number;
  readonly after?: { at: Date; id: string };
  readonly snapshotSequence?: number;
}

export class ActivityConflict extends Error {}
