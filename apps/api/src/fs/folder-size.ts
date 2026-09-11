import { FolderSizeResponse, PathQuery, ROUTES } from "@fdrive/contracts";
import {
  type CoreError,
  isUnderPath,
  joinPath,
  normalizePath,
  type Scope,
  type StorageProvider,
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

interface SizeRegion {
  readonly scope: Scope;
  readonly virtualPrefix: string;
  readonly relativePrefix: string;
  readonly excludedRelativePrefixes: readonly string[];
}

function containingScope(scopes: readonly Scope[], path: string): Scope | null {
  let best: Scope | null = null;
  for (const scope of scopes) {
    if (path !== scope.virtualPrefix && !isUnderPath(scope.virtualPrefix, path)) continue;
    if (best === null || scope.virtualPrefix.length > best.virtualPrefix.length) best = scope;
  }
  return best;
}

function mapThroughScope(scope: Scope, virtualPath: string): string {
  if (virtualPath === scope.virtualPrefix) return scope.fsPrefix;
  const relative =
    scope.virtualPrefix === "/"
      ? virtualPath.slice(1)
      : virtualPath.slice(scope.virtualPrefix.length + 1);
  return joinPath(scope.fsPrefix, relative);
}

function outermostBoundaries(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  return sorted.filter((candidate, index) =>
    sorted.slice(0, index).every((parent) => !isUnderPath(parent, candidate)),
  );
}

/** Partitions a requested virtual subtree into its physical mapping regions. */
function sizeRegions(
  scopes: readonly Scope[],
  path: string,
  trashPath: string | null,
): SizeRegion[] {
  const owner = containingScope(scopes, path);
  if (owner === null) return [];

  const regionScopes = [
    { scope: owner, virtualPrefix: path },
    ...scopes
      .filter((scope) => isUnderPath(path, scope.virtualPrefix))
      .map((scope) => ({ scope, virtualPrefix: scope.virtualPrefix })),
  ].filter(
    (region) =>
      trashPath === null ||
      (region.virtualPrefix !== trashPath && !isUnderPath(trashPath, region.virtualPrefix)),
  );

  return regionScopes.map((region) => {
    const boundaries = scopes
      .filter((scope) => isUnderPath(region.virtualPrefix, scope.virtualPrefix))
      .map((scope) => scope.virtualPrefix);
    if (trashPath !== null && isUnderPath(region.virtualPrefix, trashPath))
      boundaries.push(trashPath);

    return {
      ...region,
      relativePrefix: toIndexRelativePath(mapThroughScope(region.scope, region.virtualPrefix)),
      excludedRelativePrefixes: outermostBoundaries(boundaries).map((boundary) =>
        toIndexRelativePath(mapThroughScope(region.scope, boundary)),
      ),
    };
  });
}

/**
 * Registers `GET /fs/folder-size?path=`: resolves the virtual `path` to an
 * physical regions via the caller's *verified* index scopes, then proves the
 * caller can still read the requested directory and each nested mapped root
 * before touching the index. Each physical aggregate excludes the trees
 * shadowed by more-specific mappings and configured trash; separately mapped
 * roots are added back after their own live read succeeds.
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

    const regions = sizeRegions(verified.scopes, path, trashPath ?? null);
    const firstRegion = regions[0];
    if (firstRegion === undefined) {
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

    const authorizedRegions = [firstRegion];
    for (const region of regions.slice(1)) {
      const regionAuth = await authorizer.authorize({ path: region.virtualPrefix, kind: "dir" });
      if (regionAuth.allowed) {
        authorizedRegions.push(region);
      } else if (regionAuth.reason === "unavailable") {
        throw new ApiHttpError("upstream_unavailable", "cannot read mapped folder");
      }
    }

    const rootIds = await deps.indexQueries.rootIdsByName();
    const indexedRegions = authorizedRegions.flatMap((region) => {
      const rootId = rootIds[region.scope.rootName];
      return rootId === undefined ? [] : [{ ...region, rootId }];
    });
    if (indexedRegions.length === 0) {
      return notIndexed();
    }

    const scopePrefixes = verified.scopes.flatMap((scope) => {
      const scopeRootId = rootIds[scope.rootName];
      return scopeRootId === undefined ? [] : [{ rootId: scopeRootId, fsPrefix: scope.fsPrefix }];
    });

    const sizes = await Promise.all(
      indexedRegions.map((region) =>
        region.excludedRelativePrefixes.length === 0
          ? deps.indexQueries.subtreeSize(scopePrefixes, region.rootId, region.relativePrefix)
          : deps.indexQueries.subtreeSize(
              scopePrefixes,
              region.rootId,
              region.relativePrefix,
              region.excludedRelativePrefixes,
            ),
      ),
    );
    const { bytes, files } = sizes.reduce(
      (total, size) => ({ bytes: total.bytes + size.bytes, files: total.files + size.files }),
      { bytes: 0, files: 0 },
    );

    return c.json(FolderSizeResponse.parse({ path, bytes, files, indexed: true }));
  });
}
