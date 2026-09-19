import { randomUUID } from "node:crypto";
import {
  ActivityConflict,
  type ActivityFinish,
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
      return { id: randomUUID() };
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
