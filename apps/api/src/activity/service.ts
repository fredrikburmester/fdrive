import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type {
  ActivityFacts,
  PersonalActivityAction,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { isStorageError, type StorageProvider } from "@fdrive/core";
import { ActivityConflict, type ActivityFinish, type ActivityRepo } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";

export interface ActivityRunInput {
  readonly action: PersonalActivityAction;
  readonly source?: PersonalActivitySource;
  readonly producerOperationId?: string;
  readonly batchId?: string;
  readonly requested: ActivityFacts;
  readonly before?: ActivityFacts;
  readonly failure?: (error: unknown) => ActivityFinish;
  readonly bridge?: ActivityFinish["bridge"];
  readonly subjects?: import("@fdrive/db").ActivityOperationInput["subjects"];
}
export interface ActivityServiceDeps {
  readonly repo: ActivityRepo;
  readonly clock: () => Date;
  readonly pending: (operationId: string) => void;
}
export async function activityStat(
  storage: StorageProvider,
  path: string,
): Promise<ActivityFacts | undefined> {
  try {
    const stat = await storage.stat(path);
    return {
      path,
      kind: stat.kind === "dir" ? "dir" : "file",
      size: stat.size,
      modifiedAt: stat.modifiedAt?.toISOString() ?? null,
    };
  } catch {
    return undefined;
  }
}
export function activityFailure(error: unknown): ActivityFinish {
  const kind = error instanceof ApiHttpError || isStorageError(error) ? error.kind : null;
  if (kind === "forbidden" || kind === "unauthorized" || kind === "reauth_required")
    return { outcome: "denied", errorCode: "permission_denied" };
  if (kind === "conflict") return { outcome: "conflict", errorCode: "conflict" };
  if (kind === "not_found" || kind === "bad_request" || kind === "unsupported")
    return { outcome: "failed", errorCode: kind };
  return {
    outcome: "unknown",
    errorCode: "outcome_unconfirmed",
    detail: { reason: "interrupted" },
  };
}

export function createActivityService(deps: ActivityServiceDeps) {
  const operations = new AsyncLocalStorage<{ id: string; accountId: string; identityId: string }>();
  return {
    repo: deps.repo,
    withParent<T>(principal: Principal, operationId: string, work: () => Promise<T>) {
      return operations.run(
        { id: operationId, accountId: principal.accountId, identityId: principal.identityId },
        work,
      );
    },
    async run<T>(
      principal: Principal,
      input: ActivityRunInput,
      mutate: () => Promise<T>,
      facts: (value: T) => ActivityFacts | Promise<ActivityFacts> = () => input.requested,
    ) {
      const source = input.source ?? "web";
      let operation: Awaited<ReturnType<ActivityRepo["begin"]>>;
      const parent = operations.getStore();
      try {
        operation = await deps.repo.begin({
          accountId: principal.accountId,
          identityId: principal.identityId,
          action: input.action,
          source,
          producerOperationId: input.producerOperationId ?? randomUUID(),
          ...(input.batchId ? { batchId: input.batchId } : {}),
          ...(parent?.accountId === principal.accountId &&
          parent.identityId === principal.identityId
            ? { parentOperationId: parent.id }
            : {}),
          requested: input.requested,
          ...(input.before ? { before: input.before } : {}),
          ...(input.subjects ? { subjects: input.subjects } : {}),
          requestDigest: createHash("sha256")
            .update(JSON.stringify([input.action, input.requested, input.subjects]))
            .digest("hex"),
        });
      } catch (error) {
        if (error instanceof ActivityConflict) throw new ApiHttpError("conflict", error.message);
        throw error;
      }
      if (!(await deps.repo.claim(principal.accountId, operation.id)))
        throw new ApiHttpError(
          "conflict",
          "This operation was already attempted; check its activity before retrying.",
        );
      let value: T;
      const heartbeat = setInterval(() => {
        void deps.repo
          .heartbeat(principal.accountId, operation.id)
          .catch(() => deps.pending(operation.id));
      }, 15_000);
      heartbeat.unref();
      try {
        if (principal.verifyAuthority && !(await principal.verifyAuthority()))
          throw new ApiHttpError("forbidden", "Login authority changed");
        value = await operations.run(
          { id: operation.id, accountId: principal.accountId, identityId: principal.identityId },
          mutate,
        );
      } catch (error) {
        try {
          await deps.repo.finish(
            principal.accountId,
            operation.id,
            input.failure?.(error) ?? activityFailure(error),
          );
        } catch {
          deps.pending(operation.id);
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
      try {
        const event = await deps.repo.finish(principal.accountId, operation.id, {
          outcome: "success",
          after: await facts(value),
          at: deps.clock(),
          ...(input.bridge ? { bridge: input.bridge } : {}),
        });
        return { value, eventId: event?.id ?? null, historyPending: !event };
      } catch {
        // Provider success is never retried or turned into a failed file write for history repair.
        deps.pending(operation.id);
        return { value, eventId: null, historyPending: true };
      }
    },
  };
}
export type PersonalActivityService = ReturnType<typeof createActivityService>;
