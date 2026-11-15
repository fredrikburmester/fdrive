import { randomUUID } from "node:crypto";
import {
  ActivityConflict,
  type ActivityEventRecord,
  type ActivityFinish,
  type ActivityListOptions,
  type ActivityOperationInput,
  type ActivityRepo,
} from "@fdrive/db";
import { createActivityService } from "../src/activity/service.js";

/** Provider-route tests use the real recorder with an isolated journal boundary.
 * Registry identity, transactions and durable replay have separate PostgreSQL tests. */
export function activityFixture(clock: () => Date) {
  const operations: (ActivityOperationInput & { id: string; state: string })[] = [];
  const outcomes: (ActivityFinish & {
    operationId: string;
    action: ActivityOperationInput["action"];
  })[] = [];
  const pending: string[] = [];
  /** Each finished operation's event, newest last, with the fields `list` filters and returns. */
  const events: Pick<
    ActivityEventRecord,
    | "id"
    | "ownerAccountId"
    | "identityId"
    | "action"
    | "source"
    | "outcome"
    | "before"
    | "after"
    | "occurredAt"
    | "sortAt"
  >[] = [];
  const repo = {
    async begin(input: ActivityOperationInput) {
      const prior = operations.find(
        (row) =>
          row.accountId === input.accountId &&
          row.identityId === input.identityId &&
          row.source === input.source &&
          row.producerOperationId === input.producerOperationId,
      );
      if (prior) {
        if (prior.requestDigest !== input.requestDigest)
          throw new ActivityConflict("Operation changed");
        return prior;
      }
      const operation = { ...input, id: randomUUID(), state: "prepared" };
      operations.push(operation);
      return operation;
    },
    async claim(accountId: string, id: string) {
      const row = operations.find((item) => item.id === id && item.accountId === accountId);
      if (!row || row.state !== "prepared") return false;
      row.state = "running";
      return true;
    },
    async heartbeat() {},
    async finish(accountId: string, id: string, result: ActivityFinish) {
      const row = operations.find((item) => item.id === id && item.accountId === accountId);
      if (!row) throw new Error("Operation missing");
      outcomes.push({ ...result, operationId: id, action: row.action });
      row.state = result.outcome === "success" ? "completed" : result.outcome;
      const at = result.at ?? clock();
      const event = {
        id: randomUUID(),
        ownerAccountId: accountId,
        identityId: row.identityId,
        action: row.action,
        source: row.source,
        outcome: result.outcome,
        before: result.before ?? row.before ?? row.requested,
        after: result.after ?? null,
        occurredAt: at,
        sortAt: at,
      };
      events.push(event);
      return { id: event.id };
    },
    /** Newest first, with the filters MCP's `recent_moves` uses. */
    async list(accountId: string, options: ActivityListOptions = {}) {
      return events
        .filter(
          (event) =>
            event.ownerAccountId === accountId &&
            (options.identityId === undefined || event.identityId === options.identityId) &&
            (options.action === undefined || event.action === options.action) &&
            (options.source === undefined || event.source === options.source) &&
            (options.outcome === undefined || event.outcome === options.outcome),
        )
        .reverse()
        .slice(0, Math.min(options.limit ?? 50, 100));
    },
    async withPathLock<T>(_identityId: string, _path: string, work: () => Promise<T>) {
      return work();
    },
    async completedChildren(accountId: string, id: string) {
      return operations.filter(
        (row) =>
          row.accountId === accountId && row.parentOperationId === id && row.state === "completed",
      ).length;
    },
  } as unknown as ActivityRepo;
  return {
    service: createActivityService({ repo, clock, pending: (id) => pending.push(id) }),
    operations,
    outcomes,
    pending,
  };
}
