import { createHash, randomUUID } from "node:crypto";
import type { ActivityFacts } from "@fdrive/contracts";
import {
  activityMetadataUnchanged,
  captureActivityMetadata,
  createActivityRepo,
  createRepos,
} from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import type { FsContext } from "../fs/routes.js";
import { createMetadataService, type MetadataService } from "../metadata/service.js";
import { activityRequestContext } from "./fs-context.js";
import { type ActivityRunInput, activityFailure, type PersonalActivityService } from "./service.js";

/** Durable intent outside; actual metadata and immutable outcome commit together. */
export async function recordMetadataAction<T>(
  activity: PersonalActivityService | undefined,
  c: FsContext,
  fallback: MetadataService,
  input: ActivityRunInput,
  mutate: (metadata: MetadataService) => Promise<T>,
  facts: (value: T) => ActivityFacts = () => input.requested,
): Promise<T> {
  return recordMetadataCommand(
    activity,
    c.get("principal"),
    fallback,
    { ...activityRequestContext(c), ...input },
    mutate,
    facts,
    (id) => {
      c.header("X-Activity-Status", "recorded");
      c.header("X-Activity-Event-Id", id);
    },
  );
}
export async function recordMetadataCommand<T>(
  activity: PersonalActivityService | undefined,
  principal: Principal,
  fallback: MetadataService,
  input: ActivityRunInput,
  mutate: (metadata: MetadataService) => Promise<T>,
  facts: (value: T) => ActivityFacts = () => input.requested,
  onRecorded?: (id: string) => void,
): Promise<T> {
  if (!activity) return mutate(fallback);
  const operation = await activity.repo.begin({
    accountId: principal.accountId,
    identityId: principal.identityId,
    action: input.action,
    source: input.source ?? "web",
    producerOperationId: input.producerOperationId ?? randomUUID(),
    requested: input.requested,
    requestDigest: createHash("sha256")
      .update(JSON.stringify([input.action, input.requested, input.subjects]))
      .digest("hex"),
    ...(input.before ? { before: input.before } : {}),
    ...(input.subjects ? { subjects: input.subjects } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
  });
  if (!(await activity.repo.claim(principal.accountId, operation.id)))
    throw new ApiHttpError("conflict", "Metadata operation already attempted");
  try {
    if (principal.verifyAuthority && !(await principal.verifyAuthority()))
      throw new ApiHttpError("forbidden", "Login authority changed");
    const result = await activity.repo.transaction(async (db) => {
      const repo = createActivityRepo(db);
      await repo.lockForCommit(principal.accountId, operation.id);
      const snapshot = await captureActivityMetadata(
        db,
        principal.accountId,
        principal.identityId,
        input.action,
        input.requested,
      );
      const value = await mutate(createMetadataService(createRepos(db)));
      const after = facts(value);
      const event = await repo.finish(principal.accountId, operation.id, {
        outcome: activityMetadataUnchanged(input.action, snapshot.before, after, snapshot.absent)
          ? "skipped"
          : "success",
        before: snapshot.before,
        subjects: snapshot.subjects,
        after,
      });
      return { value, eventId: event.id };
    });
    onRecorded?.(result.eventId);
    return result.value;
  } catch (error) {
    await activity.repo
      .finish(principal.accountId, operation.id, activityFailure(error))
      .catch(() => undefined);
    throw error;
  }
}
