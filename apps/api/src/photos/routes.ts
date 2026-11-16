import {
  IMAGE_EXTENSIONS,
  PathQuery,
  PhotoDetailsResponse,
  type PhotoItem,
  PhotosResponse,
  ROUTES,
} from "@fdrive/contracts";
import { baseName, type CoreError, normalizePath, toFsPath } from "@fdrive/core";
import { INDEX_ROOT_ID, type IndexQueries, type PhotoCursor } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { listedVirtualPath, roundTripVirtualPath } from "../scoping/round-trip.ts";
import {
  dateFromMtimeNs,
  indexPrefixes,
  reservedExclusion,
  toIndexRelativePath,
} from "../search/scopes.js";

const API_PREFIX = "/api/v1";

function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

/** Index rows one page of `GET /photos` reads; a page can show fewer when a row maps nowhere. */
export const PHOTOS_PAGE_SIZE = 60;

const IMAGE_EXTS = [...IMAGE_EXTENSIONS];

/** A cursor is the last row's sort time, to the microsecond, and its id. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_(\d+)$/;

export interface PhotoRoutesDeps {
  readonly indexQueries: Pick<IndexQueries, "photos" | "photoDetails">;
  readonly resolver: Pick<ScopeResolver, "scopesFor">;
  /** Whether the files folder is indexed: an indexer is configured and a feature uses it. */
  readonly indexed: () => Promise<boolean>;
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

/** The caller's scopes, or `null` while the files folder is not indexed. */
async function scopesOf(deps: PhotoRoutesDeps, username: string) {
  return (await deps.indexed()) ? deps.resolver.scopesFor(username) : null;
}

/**
 * Registers `GET /photos`, every image the caller can read, newest first by when it was
 * taken (or modified, without EXIF), a page at a time; and `GET /photos/details?path=`,
 * one image's EXIF details. Both read the index through the caller's scopes, which
 * are the permission, and leave fdrive's own folders out, as search does.
 */
export function registerPhotoRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: PhotoRoutesDeps,
): void {
  const { authed } = groups;

  authed.get(routePath(ROUTES.photos.list), async (c) => {
    const after = parseCursor(c.req.query("cursor"));
    const principal = c.get("principal");
    const scopes = await scopesOf(deps, principal.username);
    if (scopes === null) {
      return c.json(PhotosResponse.parse({ photos: [], nextCursor: null }));
    }
    const rows = await deps.indexQueries.photos(
      indexPrefixes(scopes),
      IMAGE_EXTS,
      PHOTOS_PAGE_SIZE,
      {
        exclude: reservedExclusion(scopes),
        ...(after === undefined ? {} : { after }),
      },
    );

    const mapped = rows.map((row): PhotoItem | null => {
      const path = listedVirtualPath(scopes, row.path);
      if (path === null) {
        return null;
      }
      return {
        path,
        name: baseName(path),
        size: row.size,
        modifiedAt: dateFromMtimeNs(row.mtimeNs).toISOString(),
        takenAt: row.takenAt,
      };
    });
    const last = rows.at(-1);
    return c.json(
      PhotosResponse.parse({
        photos: mapped.filter((photo) => photo !== null),
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
    const scopes = await scopesOf(deps, principal.username);
    const fsPath = scopes === null ? null : toFsPath(scopes, path);
    // A path a shared folder shadows, or one in the home's own `Shared with me`, has no details.
    if (scopes === null || fsPath === null || roundTripVirtualPath(scopes, fsPath) !== path) {
      throw notFound();
    }
    const details = await deps.indexQueries.photoDetails(
      INDEX_ROOT_ID,
      toIndexRelativePath(fsPath),
    );
    if (details === null) {
      throw notFound();
    }
    return c.json(PhotoDetailsResponse.parse(details));
  });
}
