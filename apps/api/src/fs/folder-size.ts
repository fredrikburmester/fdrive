import { FolderSizeResponse, PathQuery, ROUTES } from "@fdrive/contracts";
import {
  type CoreError,
  isUnderPath,
  normalizePath,
  type StorageProvider,
  toFsPath,
} from "@fdrive/core";
import type { IdentityRepo, IndexQueries } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { createReadAuthorizer, type ReadAuthorizer } from "../scoping/read-authorizer.ts";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { toIndexRelativePath } from "../search/scopes.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from `ROUTES.fs.folderSize`, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface FolderSizeRoutesDeps {
  readonly indexQueries: Pick<IndexQueries, "rootIdsByName" | "subtreeSize">;
  readonly resolver: Pick<ScopeResolver, "verifiedIndexScopes">;
  readonly identities: Pick<IdentityRepo, "get">;
  /**
   * The storage provider's recycle folder virtual path, when configured.
   * A requested path that is the trash folder itself, or nested under it,
   * is answered as `{ indexed: false }`, mirroring how `fs/routes.ts` hides
   * it from listings and `search/service.ts` excludes it from hits.
   */
  readonly trashPathForStorage?: (storage: StorageProvider) => string | null;
  /** Overridable for tests; defaults to `createReadAuthorizer`. */
  readonly createAuthorizer?: (
    storage: Pick<StorageProvider, "list" | "download">,
  ) => ReadAuthorizer;
}

const NOT_INDEXED: Omit<FolderSizeResponse, "path"> = {
  bytes: 0,
  files: 0,
  indexed: false,
};

/**
 * Registers `GET /fs/folder-size?path=`: resolves the virtual `path` to an
 * fs path via the caller's *verified* index scopes exactly like the thumb
 * route (`normalizePath`, identity, `verifiedIndexScopes`, `toFsPath`), then
 * proves the caller can still read that directory right now (a live
 * `authorizer.authorize({ kind: "dir" })` probe) *before* ever touching the
 * index, and only then sums every indexed file at or under that directory
 * (`IndexQueries.subtreeSize`), intersected with the caller's own verified
 * scope so a result never includes bytes outside it.
 *
 * Answers `200 { indexed: false, bytes: 0, files: 0 }` (never an error) for
 * a folder that is out of scope, not covered by any indexed root, or the
 * trash folder: none of those is information worth surfacing as a 4xx to a
 * caller who otherwise still has read access, and each is indistinguishable
 * from "this folder was simply never indexed" from the caller's point of
 * view. A folder the caller cannot currently read at all fails the live
 * read check instead, and is answered with the same 403/404 `fs/list` would
 * give for that folder, since that failure is about read access itself,
 * not about the index.
 */
export function registerFolderSizeRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: FolderSizeRoutesDeps,
): void {
  const { authed } = groups;
  const buildAuthorizer = deps.createAuthorizer ?? ((storage) => createReadAuthorizer({ storage }));

  authed.get(routePath(ROUTES.fs.folderSize), async (c) => {
    const result = PathQuery.safeParse(c.req.query());
    if (!result.success) {
      throw new ApiHttpError("bad_request", "invalid query", { issues: result.error.issues });
    }

    let path: string;
    try {
      path = normalizePath(result.data.path);
    } catch (error) {
      const coreError = error as CoreError;
      throw new ApiHttpError("bad_request", coreError.message, coreError.details);
    }

    const notIndexed = (): Response => c.json(FolderSizeResponse.parse({ path, ...NOT_INDEXED }));

    const principal = c.get("principal");
    const trashPath = deps.trashPathForStorage?.(principal.storage);
    if (trashPath != null && (path === trashPath || isUnderPath(trashPath, path)))
      return notIndexed();
    const identity = await deps.identities.get(principal.identityId);
    if (identity === null) {
      return notIndexed();
    }
    const verified = await deps.resolver.verifiedIndexScopes(identity);
    if (!verified.available) {
      return notIndexed();
    }

    const resolved = toFsPath(verified.scopes, path);
    if (resolved === null) {
      return notIndexed();
    }

    const authorizer = buildAuthorizer(principal.storage);
    const authResult = await authorizer.authorize({ path, kind: "dir" });
    if (!authResult.allowed) {
      const kind =
        authResult.reason === "denied"
          ? "forbidden"
          : authResult.reason === "missing"
            ? "not_found"
            : "upstream_unavailable";
      throw new ApiHttpError(kind, "cannot read this folder");
    }

    const rootIds = await deps.indexQueries.rootIdsByName();
    const rootId = rootIds[resolved.rootName];
    if (rootId === undefined) {
      return notIndexed();
    }

    const relativePrefix = toIndexRelativePath(resolved.fsPath);
    // `subtreeSize` also ANDs an explicit `rootId` match itself, so scopes on
    // other roots below are harmless noise, not a leak; they are kept
    // (rather than pre-filtered to `rootId`) to reuse `verified.scopes`
    // as-is.
    const scopePrefixes = verified.scopes.flatMap((scope) => {
      const scopeRootId = rootIds[scope.rootName];
      return scopeRootId === undefined ? [] : [{ rootId: scopeRootId, fsPrefix: scope.fsPrefix }];
    });

    const { bytes, files } = await deps.indexQueries.subtreeSize(
      scopePrefixes,
      rootId,
      relativePrefix,
    );

    return c.json(FolderSizeResponse.parse({ path, bytes, files, indexed: true }));
  });
}
