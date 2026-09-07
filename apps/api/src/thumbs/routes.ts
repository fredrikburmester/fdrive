import { ROUTES, ThumbQuery, type ThumbSize } from "@fdrive/contracts";
import { type CoreError, normalizePath, type StorageProvider, toFsPath } from "@fdrive/core";
import type { IdentityRepo, IndexQueries } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { createReadAuthorizer, type ReadAuthorizer } from "../scoping/read-authorizer.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
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
  readonly indexQueries: IndexQueries;
  readonly resolver: Pick<ScopeResolver, "verifiedIndexScopes">;
  readonly identities: Pick<IdentityRepo, "get">;
  /** The directory the indexer writes thumbnails into. `undefined` disables the route entirely. */
  readonly thumbsDir: string | undefined;
  readonly fileReader?: ThumbFileReader;
  /** Overridable for tests; defaults to `createReadAuthorizer`. */
  readonly createAuthorizer?: (
    storage: Pick<StorageProvider, "list" | "download">,
  ) => ReadAuthorizer;
}

/**
 * Registers `GET /thumb?path=&size=256|1024`: resolves the virtual `path`
 * to an fs path via the caller's *verified* index scopes, proves the caller
 * can still read that exact path right now (a live `storage.download`
 * open/cancel probe), and only then serves the cached WebP through the tail
 * shared with the public share thumb route (`./serve.ts`): the file's
 * sha256 in the index, its cached thumbnail for `size`, and the file on
 * disk. 404 whenever thumbnails are not configured, the path cannot be
 * resolved or verified, the live read check fails, the file is not indexed
 * or has no sha256, no thumbnail has been generated for that size yet, or
 * the cached file is missing from disk. Responses are never cached by the
 * browser (`Cache-Control: private, no-store`), so a permission or mapping
 * change is never served stale.
 */
export function registerThumbRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: ThumbRoutesDeps,
): void {
  const { authed } = groups;
  const fileReader = deps.fileReader ?? createNodeThumbFileReader();
  const buildAuthorizer = deps.createAuthorizer ?? ((storage) => createReadAuthorizer({ storage }));

  authed.get(routePath(ROUTES.thumb), async (c) => {
    if (deps.thumbsDir === undefined) {
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
    const identity = await deps.identities.get(principal.identityId);
    if (identity === null) {
      throw THUMB_NOT_FOUND();
    }
    const verified = await deps.resolver.verifiedIndexScopes(identity);
    if (!verified.available) {
      throw THUMB_NOT_FOUND();
    }

    const resolved = toFsPath(verified.scopes, path);
    if (resolved === null) {
      throw THUMB_NOT_FOUND();
    }

    const authorizer = buildAuthorizer(principal.storage);
    const authResult = await authorizer.authorize({ path, kind: "file" });
    if (!authResult.allowed) {
      throw THUMB_NOT_FOUND();
    }

    return serveThumb(
      c,
      { indexQueries: deps.indexQueries, thumbsDir: deps.thumbsDir, fileReader },
      { rootName: resolved.rootName, fsPath: resolved.fsPath, size },
    );
  });
}
