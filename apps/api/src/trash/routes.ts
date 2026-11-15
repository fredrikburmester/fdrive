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
import { isStorageError, isTrashId, TRASH_PATH } from "@fdrive/core";
import type { TrashItem } from "@fdrive/db";
import { activityHeaders, activityRequestContext, recordFsAction } from "../activity/fs-context.js";
import { activityFailure, type PersonalActivityService } from "../activity/service.js";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { type FileOperations, fileActor } from "../files/operations.js";
import {
  normalizeOrThrow,
  parseBody,
  runStorageCall,
  serializeEntry,
  toApiHttpError,
} from "../fs/routes.js";
import type { TrashItems } from "./items.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from a `ROUTES.trash.*` path, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface TrashRoutesDeps {
  /** Records Empty Trash, the parent of each item's permanent delete. */
  readonly activity: PersonalActivityService;
  /** Restores and purges items, and what followed them into Trash. */
  readonly files: Pick<FileOperations, "restore" | "purge">;
  /** What each login's Trash holds. */
  readonly trash: Pick<TrashItems, "list">;
}

/** The most items the Trash page lists. */
const LIST_LIMIT = 10_000;

/** Throws `bad_request` for anything that cannot name a Trash item, before anything is done. */
function validateTrashId(id: string): string {
  if (!isTrashId(id)) throw new ApiHttpError("bad_request", `invalid trash id: ${id}`, { id });
  return id;
}

function serializeTrashEntry(item: TrashItem): TrashEntryContract {
  return {
    id: item.id,
    originalPath: item.originalPath,
    name: item.name,
    size: item.size,
    deletedAt: item.deletedAt.toISOString(),
  };
}

/** Runs `restore`, tagging any `StorageError` it throws with `failedId` before rethrowing. */
async function restoreOne<T>(id: string, restore: () => Promise<T>): Promise<T> {
  try {
    return await restore();
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
    const listing = await deps.trash.list(c.get("principal").identityId, LIST_LIMIT);
    const body: TrashListResponse = TrashListResponse.parse({
      entries: listing.items.map(serializeTrashEntry),
      truncated: listing.truncated,
    });
    return c.json(body);
  });

  authed.post(routePath(ROUTES.trash.restore), async (c) => {
    const principal = c.get("principal");
    const body = await parseBody(TrashRestoreRequest, c);
    const validated = body.ids.map((id) => validateTrashId(id));
    const target = body.target === undefined ? undefined : normalizeOrThrow(body.target);

    const restored: FsEntry[] = [];
    const context = activityRequestContext(c);
    const batchId = context.batchId ?? randomUUID();
    for (const id of validated) {
      const done = await restoreOne(id, () =>
        deps.files.restore(
          fileActor(principal, {
            ...context,
            producerOperationId: `${context.producerOperationId}:${restored.length}`,
            batchId,
          }),
          id,
          target,
        ),
      );
      activityHeaders(c, done.history);
      restored.push(serializeEntry(done.entry));
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
      await runStorageCall(() =>
        deps.files.purge(
          fileActor(principal, {
            ...context,
            producerOperationId: `${context.producerOperationId}:${index}`,
            batchId,
          }),
          id,
        ),
      );
    }

    const responseBody: OkResponse = OkResponse.parse({ ok: true });
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.trash.empty), async (c) => {
    const principal = c.get("principal");
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
        const { items } = await deps.trash.list(principal.identityId, Number.MAX_SAFE_INTEGER);
        // Purge item by item so every emptied item keeps its own history row.
        for (const entry of items) {
          await runStorageCall(() =>
            deps.files.purge(
              fileActor(principal, {
                ...context,
                producerOperationId: `${context.producerOperationId}:leaf:${completed}`,
                batchId,
              }),
              entry.id,
            ),
          );
          completed++;
        }
      },
      () => ({ path: TRASH_PATH, completedCount: completed }),
    );

    const responseBody: OkResponse = OkResponse.parse({ ok: true });
    return c.json(responseBody);
  });
}
