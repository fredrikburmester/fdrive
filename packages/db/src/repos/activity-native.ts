import { type ActivityFacts, PersonalActivityAction } from "@fdrive/contracts";
import { and, eq } from "drizzle-orm";
import {
  activityFileBridges,
  activityFiles,
  activityOperations,
  activityTrashBindings,
} from "../schema/activity.js";
import { appendActivityOutcome } from "./activity.js";
import { activityFileAt, ensureActivityFile, lockActivityRegistry } from "./activity-registry.js";
import type { ActivityDb, ActivityOperationRecord } from "./activity-types.js";
import { appendActivityEvent, captureActivityIdentity } from "./activity-writer.js";
import type { DesktopOperationRecord } from "./desktop.js";
import type { DesktopEffectPayload } from "./desktop-effects-types.js";

export async function prepareNativeActivity(db: ActivityDb, operation: DesktopOperationRecord) {
  const request = operation.request;
  const action = PersonalActivityAction.safeParse(request.activityAction);
  if (
    !action.success ||
    typeof request.activityPath !== "string" ||
    typeof request.activityTarget !== "string"
  )
    return;
  const actor = { accountId: operation.accountId, identityId: operation.identityId };
  await captureActivityIdentity(db, actor);
  await lockActivityRegistry(db, actor.identityId);
  // Finder IDs survive Trash; resolving by the Trash path would create a second journey.
  const bridged =
    typeof request.itemId === "string"
      ? (
          await db
            .select({ file: activityFiles })
            .from(activityFileBridges)
            .innerJoin(activityFiles, eq(activityFiles.id, activityFileBridges.fileId))
            .where(
              and(
                eq(activityFileBridges.identityId, actor.identityId),
                eq(activityFileBridges.namespace, "desktop"),
                eq(activityFileBridges.externalId, request.itemId),
              ),
            )
            .limit(1)
        )[0]?.file
      : undefined;
  const file =
    bridged ??
    (request.itemId
      ? await ensureActivityFile(
          db,
          actor.identityId,
          request.activityPath,
          request.activityKind === "dir" ? "dir" : "file",
          operation.createdAt,
        )
      : await activityFileAt(db, actor.identityId, request.activityPath));
  const requested: ActivityFacts = {
    path: request.activityPath,
    targetPath: request.activityTarget,
    kind: request.activityKind === "dir" ? "dir" : "file",
  };
  await db
    .insert(activityOperations)
    .values({
      id: operation.id,
      ownerAccountId: actor.accountId,
      actorAccountId: actor.accountId,
      identityId: actor.identityId,
      action: action.data,
      source: "native",
      producerOperationId: operation.id,
      requestDigest: operation.requestHash,
      requested,
      before: requested,
      fileId: file?.id ?? null,
      fileGeneration: file?.generation ?? null,
      revisionId: file?.revisionId ?? null,
      state: "running",
    })
    .onConflictDoNothing();
  await appendActivityEvent(
    db,
    {
      ...actor,
      action: action.data,
      source: "native",
      evidence: "server_confirmed",
      stage: "intent",
      outcome: null,
      operationId: operation.id,
      idempotencyKey: `native:${operation.id}:intent`,
      before: requested,
      subjects: [
        {
          fileId: file?.id ?? null,
          identityId: actor.identityId,
          role: "primary",
          ordinal: 0,
          path: request.activityPath,
          revisionId: file?.revisionId ?? null,
        },
      ],
    },
    operation.createdAt,
  );
}

export async function finishNativeFailure(db: ActivityDb, operation: DesktopOperationRecord) {
  if (!["failed", "cancelled", "conflict", "conflicted", "uncertain"].includes(operation.state))
    return;
  const record = (
    await db
      .select()
      .from(activityOperations)
      .where(
        and(
          eq(activityOperations.id, operation.id),
          eq(activityOperations.ownerAccountId, operation.accountId),
        ),
      )
      .for("update")
  )[0];
  if (!record || record.finalEventId) return;
  const outcome =
    operation.state === "cancelled"
      ? "cancelled"
      : operation.state.startsWith("conflict")
        ? "conflict"
        : operation.state === "uncertain"
          ? "unknown"
          : "failed";
  const event = await appendActivityOutcome(
    db,
    record,
    { outcome, errorCode: `native_${outcome}` },
    new Date(),
  );
  await db
    .update(activityOperations)
    .set({
      finalEventId: event.id,
      state: outcome === "unknown" ? "uncertain" : outcome === "cancelled" ? "cancelled" : "failed",
    })
    .where(eq(activityOperations.id, operation.id));
}

/** Copy receipt facts at commit; history never joins the recovery journal afterward. */
export async function appendNativeActivity(
  db: ActivityDb,
  operation: DesktopOperationRecord,
  result: Record<string, unknown>,
  effects: DesktopEffectPayload,
) {
  const request = operation.request;
  if (!["upload", "folder", "move"].includes(String(request.kind))) return;
  const actor = { accountId: operation.accountId, identityId: operation.identityId };
  const prepared = (
    await db
      .select()
      .from(activityOperations)
      .where(
        and(
          eq(activityOperations.id, operation.id),
          eq(activityOperations.ownerAccountId, actor.accountId),
        ),
      )
      .for("update")
  )[0];
  if (!prepared) await captureActivityIdentity(db, actor);
  await lockActivityRegistry(db, actor.identityId);
  const item = result.item as {
    id?: string;
    size?: number;
    version?: { content?: string };
    path?: string;
  } | null;
  const externalId = typeof request.itemId === "string" ? request.itemId : item?.id;
  const bridge = externalId
    ? (
        await db
          .select()
          .from(activityFileBridges)
          .innerJoin(activityFiles, eq(activityFiles.id, activityFileBridges.fileId))
          .where(
            and(
              eq(activityFileBridges.identityId, actor.identityId),
              eq(activityFileBridges.namespace, "desktop"),
              eq(activityFileBridges.externalId, externalId),
            ),
          )
          .limit(1)
      )[0]
    : undefined;
  const prior = bridge?.activity_files;
  const restore = effects.restored === true || (prior?.state === "trashed" && !effects.trash);
  const action: PersonalActivityAction = effects.trash
    ? "file.trash"
    : restore
      ? "file.restore"
      : request.kind === "folder"
        ? "folder.create"
        : request.kind === "upload"
          ? request.itemId
            ? "file.save"
            : "file.create"
          : "file.move";
  const binding =
    restore && prior
      ? (
          await db
            .select()
            .from(activityTrashBindings)
            .where(
              and(
                eq(activityTrashBindings.fileId, prior.id),
                eq(activityTrashBindings.state, "bound"),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
  const before: ActivityFacts = {
    path: effects.from ?? effects.to,
    kind: effects.directory ? "dir" : "file",
  };
  const requested: ActivityFacts = {
    ...before,
    targetPath: effects.to,
    ...(binding?.trashLeaf ? { trashLeaf: binding.trashLeaf } : {}),
  };
  const after: ActivityFacts = effects.trash
    ? { ...before, trashLeaf: effects.to, trashStrategy: "fdrive_move" }
    : {
        path: effects.to,
        kind: effects.directory ? "dir" : "file",
        ...(typeof item?.size === "number" ? { size: item.size } : {}),
        ...(typeof request.sha256 === "string" ? { sha256: request.sha256 } : {}),
      };
  const record: ActivityOperationRecord = {
    id: operation.id,
    ownerAccountId: actor.accountId,
    actorAccountId: actor.accountId,
    identityId: actor.identityId,
    action,
    source: "native",
    requestDigest: operation.requestHash,
    producerOperationId: operation.id,
    batchId: null,
    parentOperationId: null,
    fileId: prior?.id ?? null,
    fileGeneration: prior?.generation ?? null,
    revisionId: prior?.revisionId ?? null,
    state: "running",
    before,
    requested,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    finalEventId: null,
  };
  const event = await appendActivityOutcome(
    db,
    {
      ...record,
      ...(prepared
        ? {
            fileId: prepared.fileId,
            fileGeneration: prepared.fileGeneration,
            revisionId: prepared.revisionId,
            action: prepared.action,
          }
        : {}),
    },
    {
      outcome: "success",
      after,
      ...(externalId ? { bridge: { namespace: "desktop", externalId } } : {}),
    },
    new Date(),
    prepared?.finalEventId ?? undefined,
  );
  if (prepared)
    await db
      .update(activityOperations)
      .set({ state: "completed", finalEventId: event.id, updatedAt: new Date() })
      .where(eq(activityOperations.id, operation.id));
}
