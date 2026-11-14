import {
  IMAGE_EXTENSIONS,
  PathQuery,
  PhotoDetailsResponse,
  type PhotoItem,
  PhotosResponse,
  ROUTES,
} from "@fdrive/contracts";
import {
  baseName,
  type CoreError,
  normalizePath,
  type StorageProvider,
  toFsPath,
} from "@fdrive/core";
import type { IdentityRepo, IndexQueries, PhotoCursor } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { createReadAuthorizer } from "../scoping/read-authorizer.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import { dateFromMtimeNs, reservedExclusion, toIndexRelativePath } from "../search/scopes.js";

const API_PREFIX = "/api/v1";

function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

/** Index rows one page of `GET /photos` reads; a page can show fewer once each is checked. */
export const PHOTOS_PAGE_SIZE = 60;

const IMAGE_EXTS = [...IMAGE_EXTENSIONS];

/** A cursor is the last row's sort time, to the microsecond, and its id. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_(\d+)$/;

export interface PhotoRoutesDeps {
  readonly indexQueries: Pick<IndexQueries, "rootIdsByName" | "photos" | "photoDetails">;
  readonly resolver: Pick<ScopeResolver, "verifiedIndexScopes">;
  readonly identities: Pick<IdentityRepo, "get">;
  readonly trashPathForStorage?: (storage: StorageProvider) => string | null;
}

function parseCursor(raw: string | undefined): PhotoCursor | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const match = CURSOR.exec(raw);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new ApiHttpError("bad_request", "invalid cursor");
  }
  return { at: match[1], id: Number(match[2]) };
}

/** The caller's verified index scopes, or `null` when it has none. */
async function scopesOf(deps: PhotoRoutesDeps, identityId: string) {
  const identity = await deps.identities.get(identityId);
  const verified = identity === null ? null : await deps.resolver.verifiedIndexScopes(identity);
  return verified?.available === true ? verified.scopes : null;
}

/**
 * Registers `GET /photos`, every image the caller can read, newest first by when it was
 * taken (or modified, without EXIF), a page at a time; and `GET /photos/details?path=`,
 * one image's EXIF details. Both read the index through the caller's verified scopes,
 * leave fdrive's own folders out, and check a live read of every file before it is shown,
 * as search does.
 */
export function registerPhotoRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: PhotoRoutesDeps,
): void {
  const { authed } = groups;

  authed.get(routePath(ROUTES.photos.list), async (c) => {
    const after = parseCursor(c.req.query("cursor"));
    const principal = c.get("principal");
    const scopes = await scopesOf(deps, principal.identityId);
    if (scopes === null) {
      return c.json(PhotosResponse.parse({ photos: [], nextCursor: null }));
    }
    const rootIds = await deps.indexQueries.rootIdsByName();
    const rootNames = new Map(Object.entries(rootIds).map(([name, id]) => [id, name]));
    const prefixes = scopes.flatMap((scope) => {
      const rootId = rootIds[scope.rootName];
      return rootId === undefined ? [] : [{ rootId, fsPrefix: scope.fsPrefix }];
    });
    const trashPath = deps.trashPathForStorage?.(principal.storage) ?? null;
    const rows = await deps.indexQueries.photos(prefixes, IMAGE_EXTS, PHOTOS_PAGE_SIZE, {
      exclude: reservedExclusion(scopes, trashPath, rootIds),
      ...(after === undefined ? {} : { after }),
    });

    const authorizer = createReadAuthorizer({ storage: principal.storage });
    const checked = await Promise.all(
      rows.map(async (row): Promise<PhotoItem | null> => {
        const rootName = rootNames.get(row.rootId);
        const path =
          rootName === undefined ? null : roundTripVirtualPath(scopes, rootName, row.path);
        if (path === null || !(await authorizer.authorize({ path, kind: "file" })).allowed) {
          return null;
        }
        return {
          path,
          name: baseName(path),
          size: row.size,
          modifiedAt: dateFromMtimeNs(row.mtimeNs).toISOString(),
          takenAt: row.takenAt,
        };
      }),
    );
    const last = rows.at(-1);
    return c.json(
      PhotosResponse.parse({
        photos: checked.filter((photo) => photo !== null),
        nextCursor:
          last !== undefined && rows.length === PHOTOS_PAGE_SIZE ? `${last.at}_${last.id}` : null,
      }),
    );
  });

  authed.get(routePath(ROUTES.photos.details), async (c) => {
    const query = PathQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new ApiHttpError("bad_request", "invalid query", { issues: query.error.issues });
    }
    let path: string;
    try {
      path = normalizePath(query.data.path);
    } catch (error) {
      const coreError = error as CoreError;
      throw new ApiHttpError("bad_request", coreError.message, coreError.details);
    }
    const notFound = () => new ApiHttpError("not_found", "no photo details");
    const principal = c.get("principal");
    const scopes = await scopesOf(deps, principal.identityId);
    const resolved = scopes === null ? null : toFsPath(scopes, path);
    const rootId =
      resolved === null ? undefined : (await deps.indexQueries.rootIdsByName())[resolved.rootName];
    if (resolved === null || rootId === undefined) {
      throw notFound();
    }
    const authorizer = createReadAuthorizer({ storage: principal.storage });
    if (!(await authorizer.authorize({ path, kind: "file" })).allowed) {
      throw notFound();
    }
    const details = await deps.indexQueries.photoDetails(
      rootId,
      toIndexRelativePath(resolved.fsPath),
    );
    if (details === null) {
      throw notFound();
    }
    return c.json(PhotoDetailsResponse.parse(details));
  });
}
