import {
  type FsEntry,
  OkResponse,
  ROUTES,
  type TrashEntry as TrashEntryContract,
  TrashListResponse,
  TrashPurgeRequest,
  TrashRestoreRequest,
  TrashRestoreResponse,
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
  /**
   * The storage provider's recycle folder virtual path, when configured
   * (`config.ts`'s `fdriveSftpgoTrashPath`). `null` means no operator has
   * set up a trash: every route but `status` answers 404.
   */
  readonly trashPath: string | null;
  /** Informational only; surfaced verbatim in `TrashStatusResponse`. */
  readonly retentionHours: number | null;
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
  if (trash === undefined || deps.trashPath === null) {
    throw new ApiHttpError("not_found", "trash is not configured");
  }
  return { trash, trashPath: deps.trashPath };
}

interface ValidatedTrashId {
  readonly id: string;
  /** The id's parsed original path: the default restore target when the request gives none. */
  readonly originalPath: string;
}

/** Throws `bad_request` for an id that does not parse as a well-formed trash leaf under `trashPath`. */
function validateTrashId(trashPath: string, id: string): ValidatedTrashId {
  const leafPath = trashLeafPath(trashPath, id);
  const parsed = parseTrashLeaf(trashPath, leafPath);
  if (parsed === null) {
    throw new ApiHttpError("bad_request", `invalid trash id: ${id}`, { id });
  }
  return { id, originalPath: parsed.originalPath };
}

/**
 * Throws `conflict` (with `details.failedId`) when `target` already exists.
 * Real SFTPGo's rename endpoint silently overwrites an existing file
 * instead of erroring (unlike `TrashProvider.restore`'s documented
 * contract), so restoring would otherwise destroy whatever already lives
 * at the target without warning; this check runs first so restore never
 * does that. A `bad_request` from `statFile` (this codebase's convention
 * for "this path is a directory", see `fs/routes.ts`'s `statEntry`) is left
 * for `restoreOne`'s own move/mkdir calls to report, since that failure
 * mode is unrelated to an existing file at the target.
 */
async function checkRestoreTargetFree(
  storage: StorageProvider,
  target: string,
  id: string,
): Promise<void> {
  try {
    await storage.statFile(target);
  } catch (error) {
    if (isStorageError(error)) {
      return;
    }
    throw error;
  }
  throw new ApiHttpError("conflict", `something already exists at ${target}`, { failedId: id });
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
    const body: TrashStatusResponse = TrashStatusResponse.parse({
      available: principal.storage.trash !== undefined,
      path: deps.trashPath,
      retentionHours: deps.retentionHours,
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
    for (const { id, originalPath } of validated) {
      const resolvedTarget = target ?? originalPath;
      await checkRestoreTargetFree(principal.storage, resolvedTarget, id);
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
    const ids = body.ids.map((id) => validateTrashId(trashPath, id).id);

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
