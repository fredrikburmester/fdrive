import {
  CreateTagRequest,
  FavoriteRequest,
  type FavoritesResponse,
  type FolderViewResponse,
  type OkResponse,
  type RecentsResponse,
  RecentTouchRequest,
  RemoveFolderViewRequest,
  ROUTES,
  SetFileTagsRequest,
  SetFolderViewRequest,
  type Tag,
  type TagFilesResponse,
  type TagsResponse,
  UpdateTagRequest,
} from "@fdrive/contracts";
import { ConflictError } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { normalizeOrThrow, parseBody, statEntry } from "../fs/routes.js";
import { type MetadataService, UnknownTagError } from "./service.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from a route path, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface MetadataRoutesDeps {
  readonly metadata: MetadataService;
}

/** Runs `fn`, mapping a `ConflictError` (a duplicate tag name) into a 409 `ApiHttpError`. */
async function runTagCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new ApiHttpError("conflict", error.message);
    }
    throw error;
  }
}

/**
 * Registers the phase 3 metadata routes: tag CRUD and per-tag file listing,
 * `PUT /fs/tags` (replace a path's tags), and favorites/recents CRUD. Tags
 * are scoped to the caller's account (shared across every linked identity);
 * `file_tags`, favorites, and recents are scoped to the caller's active
 * identity, matching every other fs-facing route.
 */
export function registerMetadataRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: MetadataRoutesDeps,
): void {
  const { authed } = groups;
  const { metadata } = deps;

  authed.get(routePath(ROUTES.tags), async (c) => {
    const principal = c.get("principal");
    const tags = await metadata.listTags(principal.accountId);
    const body: TagsResponse = { tags };
    return c.json(body);
  });

  authed.post(routePath(ROUTES.tags), async (c) => {
    const principal = c.get("principal");
    const input = await parseBody(CreateTagRequest, c);
    const tag = await runTagCall(() =>
      metadata.createTag(principal.accountId, { name: input.name, color: input.color ?? null }),
    );
    const body: Tag = tag;
    return c.json(body, 201);
  });

  authed.patch(`${routePath(ROUTES.tags)}/:id`, async (c) => {
    const principal = c.get("principal");
    const id = c.req.param("id");
    const input = await parseBody(UpdateTagRequest, c);
    const patch: { name?: string; color?: string | null } = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    };
    const tag = await runTagCall(() => metadata.updateTag(principal.accountId, id, patch));
    if (tag === null) {
      throw new ApiHttpError("not_found", `tag not found: ${id}`);
    }
    const body: Tag = tag;
    return c.json(body);
  });

  authed.delete(`${routePath(ROUTES.tags)}/:id`, async (c) => {
    const principal = c.get("principal");
    const id = c.req.param("id");
    await metadata.deleteTag(principal.accountId, id);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  authed.get(`${routePath(ROUTES.tags)}/:id/files`, async (c) => {
    const principal = c.get("principal");
    const id = c.req.param("id");
    const paths = await metadata.filesForTag(principal.identityId, id);
    const body: TagFilesResponse = { paths };
    return c.json(body);
  });

  authed.put(routePath(ROUTES.fs.tags), async (c) => {
    const principal = c.get("principal");
    const input = await parseBody(SetFileTagsRequest, c);
    const path = normalizeOrThrow(input.path);
    try {
      await metadata.setFileTags(
        { accountId: principal.accountId, identityId: principal.identityId },
        path,
        input.tagIds,
      );
    } catch (err) {
      if (err instanceof UnknownTagError) {
        throw new ApiHttpError("bad_request", err.message, { tagIds: err.tagIds });
      }
      throw err;
    }
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  authed.get(routePath(ROUTES.favorites.base), async (c) => {
    const principal = c.get("principal");
    const items = await metadata.listFavorites(principal.identityId);
    const body: FavoritesResponse = {
      items: items.map((item) => ({
        path: item.path,
        kind: item.kind,
        addedAt: item.addedAt.toISOString(),
      })),
    };
    return c.json(body);
  });

  authed.post(routePath(ROUTES.favorites.base), async (c) => {
    const principal = c.get("principal");
    const input = await parseBody(FavoriteRequest, c);
    const path = normalizeOrThrow(input.path);
    const entry = await statEntry(principal.storage, path);
    const kind = entry.kind === "dir" ? "dir" : "file";
    await metadata.addFavorite(principal.identityId, path, kind);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  authed.delete(routePath(ROUTES.favorites.base), async (c) => {
    const principal = c.get("principal");
    const input = await parseBody(FavoriteRequest, c);
    const path = normalizeOrThrow(input.path);
    await metadata.removeFavorite(principal.identityId, path);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  authed.get(routePath(ROUTES.folderViews.base), async (c) => {
    const principal = c.get("principal");
    const path = normalizeOrThrow(c.req.query("path") ?? "");
    const view = await metadata.getFolderView(principal.identityId, path);
    if (view === null) {
      const body: FolderViewResponse = { view: null };
      return c.json(body);
    }
    try {
      const entry = await statEntry(principal.storage, path);
      if (entry.kind === "dir") {
        const body: FolderViewResponse = { view };
        return c.json(body);
      }
    } catch (error) {
      if (!(error instanceof ApiHttpError) || error.kind !== "not_found") throw error;
    }
    // A read cannot tell a permanent deletion from a path or mount that is
    // temporarily unavailable. Explicit filesystem mutations reconcile pins.
    const body: FolderViewResponse = { view: null };
    return c.json(body);
  });

  authed.put(routePath(ROUTES.folderViews.base), async (c) => {
    const principal = c.get("principal");
    const input = await parseBody(SetFolderViewRequest, c);
    const path = normalizeOrThrow(input.path);
    const entry = await statEntry(principal.storage, path);
    if (entry.kind !== "dir") throw new ApiHttpError("bad_request", "path must be a directory");
    await metadata.setFolderView(principal.identityId, path, input.mode);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  authed.delete(routePath(ROUTES.folderViews.all), async (c) => {
    const principal = c.get("principal");
    await metadata.resetFolderViews(principal.accountId);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  authed.delete(routePath(ROUTES.folderViews.base), async (c) => {
    const principal = c.get("principal");
    const input = await parseBody(RemoveFolderViewRequest, c);
    const path = normalizeOrThrow(input.path);
    await metadata.removeFolderView(principal.identityId, path);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  authed.get(routePath(ROUTES.recents.list), async (c) => {
    const principal = c.get("principal");
    const items = await metadata.listRecents(principal.identityId);
    const body: RecentsResponse = {
      items: items.map((item) => ({ path: item.path, openedAt: item.openedAt.toISOString() })),
    };
    return c.json(body);
  });

  authed.post(routePath(ROUTES.recents.touch), async (c) => {
    const principal = c.get("principal");
    const input = await parseBody(RecentTouchRequest, c);
    const path = normalizeOrThrow(input.path);
    await metadata.touchRecent(principal.identityId, path);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
