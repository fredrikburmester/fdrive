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
  type TrashSettings,
  TrashStatusResponse,
} from "@fdrive/contracts";
import {
  isStorageError,
  parseMoveTrashLeaf,
  type StorageProvider,
  type TrashEntry,
  type TrashProvider,
  type TrashRestoreResult,
  trashLeafPath,
} from "@fdrive/core";
import { activityRequestContext, recordFsAction } from "../activity/fs-context.js";
import { activityFailure, type PersonalActivityService } from "../activity/service.js";
import type { AppHono, AuthedHono } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import type { EventBus } from "../events/bus.js";
import {
  type FsContext,
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
  /** Reads the provider/path revision captured with the request's storage. */
  readonly settingsForStorage: (storage: StorageProvider) => TrashSettings | null;
  /** Rewrites tag/favorite/recent metadata and what followed an item into Trash. */
  readonly metadata: MetadataService;
}

/**
 * The caller's Trash and its folder, or the shared `not_found` while Trash
 * is off. The storage factory adds a Trash only while it is on, recording
 * the settings it read beside the storage.
 */
function requireTrash(
  c: FsContext,
  deps: TrashRoutesDeps,
): { trash: TrashProvider; trashPath: string } {
  const { storage } = c.get("principal");
  const settings = deps.settingsForStorage(storage);
  if (storage.trash === undefined || settings === null) {
    throw new ApiHttpError("not_found", "trash is not configured");
  }
  return { trash: storage.trash, trashPath: settings.path };
}

/**
 * Throws `bad_request` for an id that does not parse as a well-formed trash
 * leaf under `trashPath`, otherwise returns it unchanged. The restore
 * target itself (the id's parsed original path, when the request gives no
 * explicit target) is resolved by `TrashProvider.restore` itself, along
 * with the conflict check for an already-occupied target (see
 * `@fdrive/core`'s `packages/core/src/trash/recycle-folder-trash.ts`).
 */
function validateTrashId(trashPath: string, id: string): string {
  const leafPath = trashLeafPath(trashPath, id);
  const parsed = parseMoveTrashLeaf(trashPath, leafPath);
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
 * After the leaf `id` is purged for good, what followed the item into Trash
 * (folders shared with people) ends with it. Should this fail, those records
 * still name the leaf, which no share reaches and no new item can take.
 */
async function forgetPurged(
  deps: TrashRoutesDeps,
  principal: Principal,
  trashPath: string,
  id: string,
): Promise<void> {
  const leaf = trashLeafPath(trashPath, id);
  const isDir = parseMoveTrashLeaf(trashPath, leaf)?.kind !== "file";
  await deps.metadata.onDeleted(principal.identityId, leaf, isDir);
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

  authed.get(routePath(ROUTES.trash.status), (c) => {
    const principal = c.get("principal");
    const settings = deps.settingsForStorage(principal.storage);
    const available = principal.storage.trash !== undefined && settings?.enabled === true;
    const body: TrashStatusResponse = TrashStatusResponse.parse({
      available,
      path: available ? settings.path : null,
      retentionHours: available ? settings.retentionHours : null,
    });
    return c.json(body);
  });

  authed.get(routePath(ROUTES.trash.list), async (c) => {
    const { trash } = requireTrash(c, deps);
    const listing = await runStorageCall(() => trash.list());
    const body: TrashListResponse = TrashListResponse.parse({
      entries: listing.entries.map(serializeTrashEntry),
      truncated: listing.truncated,
    });
    return c.json(body);
  });

  authed.post(routePath(ROUTES.trash.restore), async (c) => {
    const principal = c.get("principal");
    const { trash, trashPath } = requireTrash(c, deps);
    const body = await parseBody(TrashRestoreRequest, c);
    const validated = body.ids.map((id) => validateTrashId(trashPath, id));
    const target = body.target === undefined ? undefined : normalizeOrThrow(body.target);

    const restored: FsEntry[] = [];
    const trashPaths: string[] = [];
    const targetPaths: string[] = [];
    const context = activityRequestContext(c);
    const batchId = context.batchId ?? randomUUID();
    try {
      for (const id of validated) {
        const trashVirtualPath = trashLeafPath(trashPath, id);
        const originalPath =
          parseMoveTrashLeaf(trashPath, trashVirtualPath)?.originalPath ?? trashVirtualPath;
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
    const { trash, trashPath } = requireTrash(c, deps);
    const body = await parseBody(TrashPurgeRequest, c);
    const ids = body.ids.map((id) => validateTrashId(trashPath, id));

    const context = activityRequestContext(c);
    const batchId = context.batchId ?? randomUUID();
    for (const [index, id] of ids.entries()) {
      const leaf = trashLeafPath(trashPath, id);
      const path = parseMoveTrashLeaf(trashPath, leaf)?.originalPath ?? leaf;
      await recordFsAction(
        deps.activity,
        c,
        {
          ...context,
          producerOperationId: `${context.producerOperationId}:${index}`,
          batchId,
          action: "file.delete",
          requested: { path, trashLeaf: leaf },
        },
        () => runStorageCall(() => trash.purge(id)),
      );
      await forgetPurged(deps, principal, trashPath, id);
    }

    const paths = ids.map((id) => trashLeafPath(trashPath, id));
    publishFsEvent(deps, principal, "delete", paths);
    const responseBody: OkResponse = OkResponse.parse({ ok: true });
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.trash.empty), async (c) => {
    const principal = c.get("principal");
    const { trash, trashPath } = requireTrash(c, deps);
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
        requested: { path: trashPath, kind: "dir" },
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
          const leaf = trashLeafPath(trashPath, entry.id);
          await recordFsAction(
            deps.activity,
            c,
            {
              ...context,
              producerOperationId: `${context.producerOperationId}:leaf:${completed}`,
              batchId,
              action: "file.delete",
              requested: { path: entry.originalPath, trashLeaf: leaf },
            },
            () => runStorageCall(() => trash.purge(entry.id)),
          );
          await forgetPurged(deps, principal, trashPath, entry.id);
          completed++;
        }
      },
      () => ({ path: trashPath, completedCount: completed }),
    );

    publishFsEvent(deps, principal, "delete", [trashPath]);
    const responseBody: OkResponse = OkResponse.parse({ ok: true });
    return c.json(responseBody);
  });
}
