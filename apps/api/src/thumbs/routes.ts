import { ROUTES, ThumbQuery, type ThumbSize } from "@fdrive/contracts";
import { type CoreError, isReservedPath, normalizePath, toFsPath } from "@fdrive/core";
import type { IndexQueries } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import {
  createNodeThumbFileReader,
  serveThumb,
  THUMB_NOT_FOUND,
  type ThumbFileReader,
} from "./serve.js";

export type { ThumbFileReader };
export { createNodeThumbFileReader };

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from `ROUTES.thumb`, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface ThumbRoutesDeps {
  readonly enabled?: () => Promise<boolean>;
  readonly indexQueries: IndexQueries;
  readonly resolver: Pick<ScopeResolver, "scopesFor">;
  /** The directory the indexer writes thumbnails into. `undefined` disables the route entirely. */
  readonly thumbsDir: string | undefined;
  readonly fileReader?: ThumbFileReader;
}

/**
 * Registers `GET /thumb?path=&size=256|1024`: maps the virtual `path`
 * through the caller's scopes, resolved for this request
 * (a revoked share stops at once), and serves the cached WebP through the
 * tail shared with the public share thumb route (`./serve.ts`): the file's
 * sha256 in the index, its cached thumbnail for `size`, and the file on
 * disk. The scope is the permission: no storage is read. 404 whenever
 * thumbnails are not configured, the path is one of fdrive's own folders
 * or does not map to the index and back to itself (a folder a nested scope
 * shadows), the file is not indexed or has no sha256, no thumbnail has been
 * generated for that size yet, or the cached file is missing from disk.
 * Responses are cached privately and revalidated on every use against the
 * sha256 `ETag`, so a changed file or a lost permission is never shown from
 * the browser's cache.
 */
export function registerThumbRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: ThumbRoutesDeps,
): void {
  const { authed } = groups;
  const fileReader = deps.fileReader ?? createNodeThumbFileReader();

  authed.get(routePath(ROUTES.thumb), async (c) => {
    if (deps.thumbsDir === undefined || (deps.enabled !== undefined && !(await deps.enabled()))) {
      throw THUMB_NOT_FOUND();
    }

    const result = ThumbQuery.safeParse(c.req.query());
    if (!result.success) {
      throw new ApiHttpError("bad_request", "invalid query", { issues: result.error.issues });
    }
    const size = Number(result.data.size) as ThumbSize;

    let path: string;
    try {
      path = normalizePath(result.data.path);
    } catch (error) {
      const coreError = error as CoreError;
      throw new ApiHttpError("bad_request", coreError.message, coreError.details);
    }

    const principal = c.get("principal");
    if (isReservedPath(path)) {
      throw THUMB_NOT_FOUND();
    }
    const scopes = await deps.resolver.scopesFor(principal.username);
    const fsPath = toFsPath(scopes, path);
    if (fsPath === null || roundTripVirtualPath(scopes, fsPath) !== path) {
      throw THUMB_NOT_FOUND();
    }

    return serveThumb(
      c,
      { indexQueries: deps.indexQueries, thumbsDir: deps.thumbsDir, fileReader },
      { fsPath, size },
    );
  });
}
