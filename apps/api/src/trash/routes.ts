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
  TRASH_PATH,
  type TrashEntry,
  trashLeafPath,
} from "@fdrive/core";
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
    const trash = c.get("principal").storage.trash;
    const listing = await runStorageCall(() => trash.list());
    const body: TrashListResponse = TrashListResponse.parse({
      entries: listing.entries.map(serializeTrashEntry),
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
    const trash = principal.storage.trash;
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
