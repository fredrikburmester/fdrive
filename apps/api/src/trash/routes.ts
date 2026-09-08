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
  type FileEntry,
  isStorageError,
  parseTrashLeaf,
  type StorageProvider,
  type TrashEntry,
  type TrashProvider,
  trashLeafPath,
} from "@fdrive/core";
import type { AppHono, AuthedHono } from "../app.js";
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
  readonly bus: EventBus;
  readonly clock: () => Date;
  /** Reads the provider/path revision captured with the request's storage. */
  readonly settingsForStorage: (storage: StorageProvider) => TrashSettings | null;
  /**
   * Rewrites tag/favorite/recent metadata after a restore, keyed at the
   * restored path. Optional so route tests that do not exercise metadata
   * can omit it; `composition.ts` always wires the real service.
   */
  readonly metadata?: MetadataService;
}

/**
 * Resolves the caller's `TrashProvider` and the configured trash path
 * together, throwing the shared `not_found` when either is missing: the
 * identity's storage exposes no trash, or (defensively, should never
 * happen in a correctly wired `composeApp`) the deployment's trash path is
 * unset even though this identity's storage somehow has one.
 */
function requireTrash(
  c: FsContext,
  deps: TrashRoutesDeps,
): { trash: TrashProvider; trashPath: string } {
  const principal = c.get("principal");
  const trash = principal.storage.trash;
  const settings = deps.settingsForStorage(principal.storage);
  if (trash === undefined || settings?.enabled !== true) {
    throw new ApiHttpError("not_found", "trash is not configured");
  }
  return { trash, trashPath: settings.path };
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
  const parsed = parseTrashLeaf(trashPath, leafPath);
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

/** Runs `trash.restore(id, ...)`, tagging any `StorageError` it throws with `failedId` before rethrowing. */
async function restoreOne(
  trash: TrashProvider,
  id: string,
  target: string | undefined,
): Promise<FileEntry> {
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
    for (const id of validated) {
      const entry = await restoreOne(trash, id, target);
      const trashVirtualPath = trashLeafPath(trashPath, id);
      if (deps.metadata !== undefined) {
        await deps.metadata.onMoved(principal.identityId, trashVirtualPath, entry.path, false);
      }
      restored.push(serializeEntry(entry));
      trashPaths.push(trashVirtualPath);
      targetPaths.push(entry.path);
    }

    publishFsEvent(deps, principal, "move", trashPaths, targetPaths);
    const responseBody: TrashRestoreResponse = TrashRestoreResponse.parse({ restored });
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.trash.purge), async (c) => {
    const principal = c.get("principal");
    const { trash, trashPath } = requireTrash(c, deps);
    const body = await parseBody(TrashPurgeRequest, c);
    const ids = body.ids.map((id) => validateTrashId(trashPath, id));

    await runStorageCall(() => trash.purge(ids));

    const paths = ids.map((id) => trashLeafPath(trashPath, id));
    publishFsEvent(deps, principal, "delete", paths);
    const responseBody: OkResponse = OkResponse.parse({ ok: true });
    return c.json(responseBody);
  });

  authed.post(routePath(ROUTES.trash.empty), async (c) => {
    const principal = c.get("principal");
    const { trash, trashPath } = requireTrash(c, deps);

    await runStorageCall(() => trash.empty());

    publishFsEvent(deps, principal, "delete", [trashPath]);
    const responseBody: OkResponse = OkResponse.parse({ ok: true });
    return c.json(responseBody);
  });
}
