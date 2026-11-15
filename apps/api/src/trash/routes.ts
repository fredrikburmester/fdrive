import { randomUUID } from "node:crypto";
import {
  type FsEntry,
  OkResponse,
  ROUTES,
  type TrashEntry as TrashEntryContract,
  TrashListResponse,
  TrashPurgeRequest,
  TrashRestoreRequest,
  TrashRestoreResponse,
} from "@fdrive/contracts";
import {
  isStorageError,
  parseMoveTrashLeaf,
  type StorageProvider,
  TRASH_PATH,
  type TrashEntry,
  type TrashProvider,
  type TrashRestoreResult,
  trashLeafPath,
} from "@fdrive/core";
import {
  type ActivityCallContext,
  activityRequestContext,
  recordActivity,
  recordFsAction,
} from "../activity/fs-context.js";
import { activityFailure, type PersonalActivityService } from "../activity/service.js";
import type { AppHono, AuthedHono } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import type { EventBus } from "../events/bus.js";
import {
  normalizeOrThrow,
  parseBody,
  publishFsEvent,
  runStorageCall,
  serializeEntry,
  toApiHttpError,
} from "../fs/routes.js";
import type { MetadataService } from "../metadata/service.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from a `ROUTES.trash.*` path, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface TrashRoutesDeps {
  readonly activity: PersonalActivityService;
  readonly bus: EventBus;
  readonly clock: () => Date;
  /** Rewrites tag/favorite/recent metadata and what followed an item into Trash. */
  readonly metadata: MetadataService;
}

/** The storage's Trash, which every user's storage has. */
export function trashOf(storage: StorageProvider): TrashProvider {
  if (storage.trash === undefined) throw new Error("this storage was built without Trash");
  return storage.trash;
}

/**
 * Throws `bad_request` for an id that does not parse as a well-formed trash
 * leaf, otherwise returns it unchanged. The restore target itself (the id's
 * parsed original path, when the request gives no explicit target) is
 * resolved by `TrashProvider.restore` itself, along with the conflict check
 * for an already-occupied target (see `@fdrive/core`'s
 * `packages/core/src/trash/recycle-folder-trash.ts`).
 */
function validateTrashId(id: string): string {
  const parsed = parseMoveTrashLeaf(TRASH_PATH, trashLeafPath(TRASH_PATH, id));
  if (parsed === null) {
    throw new ApiHttpError("bad_request", `invalid trash id: ${id}`, { id });
  }
  return id;
}

function serializeTrashEntry(entry: TrashEntry): TrashEntryContract {
  return {
    id: entry.id,
    originalPath: entry.originalPath,
    name: entry.name,
    size: entry.size,
    deletedAt: entry.deletedAt.toISOString(),
  };
}

/** Path-keyed metadata belongs to a replacement entry if the original path is live again. */
async function originalPathIsMissing(storage: StorageProvider, path: string): Promise<boolean> {
  try {
    await storage.stat(path);
    return false;
  } catch (error) {
    if (isStorageError(error) && error.kind === "not_found") return true;
    throw error;
  }
}

/**
 * Deletes the leaf `id` from `principal`'s Trash for good and records it as
 * a permanent delete of the item it held. Then what followed the item into
 * Trash (folders shared with people, public links) ends with it. Should that
 * fail, those records still name the leaf, which no share reaches and no new
 * item can take. Purge, Empty Trash and retention all delete this way.
 */
export async function purgeTrashItem(
  deps: Pick<TrashRoutesDeps, "activity" | "metadata">,
  principal: Principal,
  id: string,
  context: ActivityCallContext & { readonly reason?: "retention" },
): Promise<void> {
  const leaf = trashLeafPath(TRASH_PATH, id);
  const parsed = parseMoveTrashLeaf(TRASH_PATH, leaf);
  const trash = trashOf(principal.storage);
  await recordActivity(
    deps.activity,
    principal,
    {
      source: context.source,
      ...(context.producerOperationId ? { producerOperationId: context.producerOperationId } : {}),
      ...(context.batchId ? { batchId: context.batchId } : {}),
      action: "file.delete",
      requested: {
        path: parsed?.originalPath ?? leaf,
        trashLeaf: leaf,
        ...(context.reason ? { reason: context.reason } : {}),
      },
    },
    () => runStorageCall(() => trash.purge(id)),
  );
  await deps.metadata.onDeleted(principal.identityId, leaf, parsed?.kind !== "file");
}

/** Runs `trash.restore(id, ...)`, tagging any `StorageError` it throws with `failedId` before rethrowing. */
async function restoreOne(
  trash: TrashProvider,
  id: string,
  target: string | undefined,
): Promise<TrashRestoreResult> {
  const restoreOptions = target === undefined ? undefined : { target };
  try {
    return await trash.restore(id, restoreOptions);
  } catch (error) {
    if (isStorageError(error)) {
      const mapped = toApiHttpError(error);
      throw new ApiHttpError(mapped.kind, mapped.message, {
        ...(mapped.details ?? {}),
        failedId: id,
      });
    }
    throw error;
  }
}

/**
 * Registers every `/trash/*` route (status, list, restore, purge, empty) on
 * the authed group, using `ROUTES.trash.*` (minus the `/api/v1` prefix,
 * since `authed` is already mounted there).
 */
export function registerTrashRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: TrashRoutesDeps,
): void {
  const { authed } = groups;

  authed.get(routePath(ROUTES.trash.list), async (c) => {
    const trash = trashOf(c.get("principal").storage);
    const listing = await runStorageCall(() => trash.list());
    const body: TrashListResponse = TrashListResponse.parse({
      entries: listing.entries.map(serializeTrashEntry),
      truncated: listing.truncated,
    });
    return c.json(body);
  });

  authed.post(routePath(ROUTES.trash.restore), async (c) => {
    const principal = c.get("principal");
    const trash = trashOf(principal.storage);
    const body = await parseBody(TrashRestoreRequest, c);
    const validated = body.ids.map((id) => validateTrashId(id));
    const target = body.target === undefined ? undefined : normalizeOrThrow(body.target);

    const restored: FsEntry[] = [];
    const trashPaths: string[] = [];
    const targetPaths: string[] = [];
    const context = activityRequestContext(c);
    const batchId = context.batchId ?? randomUUID();
    try {
      for (const id of validated) {
        const trashVirtualPath = trashLeafPath(TRASH_PATH, id);
        const originalPath =
          parseMoveTrashLeaf(TRASH_PATH, trashVirtualPath)?.originalPath ?? trashVirtualPath;
        const entry = await recordFsAction(
          deps.activity,
          c,
          {
            ...context,
            producerOperationId: `${context.producerOperationId}:${restored.length}`,
            batchId,
            action: "file.restore",
            requested: {
              path: originalPath,
              trashLeaf: trashVirtualPath,
              ...(target ? { targetPath: target } : {}),
            },
          },
          () => restoreOne(trash, id, target),
          (entry) => ({
            path: entry.path,
            kind: entry.kind === "dir" ? "dir" : "file",
            size: entry.size,
          }),
        );
        trashPaths.push(trashVirtualPath);
        targetPaths.push(entry.path);
        if (
          entry.originalPath !== entry.path &&
          (await runStorageCall(() => originalPathIsMissing(principal.storage, entry.originalPath)))
        ) {
          await deps.metadata.onMoved(
            principal.identityId,
            entry.originalPath,
            entry.path,
            entry.kind === "dir",
          );
        }
        // A restore is a move out of Trash: shares that followed the item there come back with it.
        await deps.metadata.onMoved(
          principal.identityId,
          trashVirtualPath,
          entry.path,
          entry.kind === "dir",
        );
        restored.push(serializeEntry(entry));
      }
    } finally {
      if (trashPaths.length > 0) publishFsEvent(deps, principal, "move", trashPaths, targetPaths);
    }
    const responseBody: TrashRestoreResponse = TrashRestoreResponse.parse({ restored });
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.trash.purge), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(TrashPurgeRequest, c);
    const ids = body.ids.map((id) => validateTrashId(id));

    const context = activityRequestContext(c);
    const batchId = context.batchId ?? randomUUID();
    for (const [index, id] of ids.entries()) {
      await purgeTrashItem(deps, principal, id, {
        ...context,
        producerOperationId: `${context.producerOperationId}:${index}`,
        batchId,
      });
    }

    const paths = ids.map((id) => trashLeafPath(TRASH_PATH, id));
    publishFsEvent(deps, principal, "delete", paths);
    const responseBody: OkResponse = OkResponse.parse({ ok: true });
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.trash.empty), async (c) => {
    const principal = c.get("principal");
    const trash = trashOf(principal.storage);
    const context = activityRequestContext(c);
    const batchId = context.batchId ?? randomUUID();
    let completed = 0;
    await recordFsAction(
      deps.activity,
      c,
      {
        ...context,
        batchId,
        action: "trash.empty",
        requested: { path: TRASH_PATH, kind: "dir" },
        failure: (error) =>
          completed > 0
            ? {
                outcome: "partial",
                detail: { completedCount: completed, failedCount: 1 },
                errorCode: "partial",
              }
            : activityFailure(error),
      },
      async () => {
        // Every item, also clearing the empty folders the layout holds.
        const { entries } = await runStorageCall(() =>
          trash.list({ limit: Number.POSITIVE_INFINITY, prune: true, signal: c.req.raw.signal }),
        );
        // Purge item by item so every emptied item keeps its own history row.
        for (const entry of entries) {
          await purgeTrashItem(deps, principal, entry.id, {
            ...context,
            producerOperationId: `${context.producerOperationId}:leaf:${completed}`,
            batchId,
          });
          completed++;
        }
      },
      () => ({ path: TRASH_PATH, completedCount: completed }),
    );

    publishFsEvent(deps, principal, "delete", [TRASH_PATH]);
    const responseBody: OkResponse = OkResponse.parse({ ok: true });
    return c.json(responseBody);
  });
}
