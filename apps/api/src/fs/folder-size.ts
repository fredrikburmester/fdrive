import { FolderSizeResponse, PathQuery, ROUTES } from "@fdrive/contracts";
import {
  type CoreError,
  isUnderPath,
  isWithin,
  joinPath,
  normalizePath,
  type Scope,
  type StorageProvider,
} from "@fdrive/core";
import { INDEX_ROOT_ID, type IndexQueries } from "@fdrive/db";
import { SHARED_WITH_ME } from "@fdrive/local";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import type { ScopeResolver } from "../scoping/resolver.ts";
import { indexPrefixes, toIndexRelativePath } from "../search/scopes.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from `ROUTES.fs.folderSize`, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface FolderSizeRoutesDeps {
  readonly indexQueries: Pick<IndexQueries, "subtreeSize">;
  readonly resolver: Pick<ScopeResolver, "scopesFor">;
  /** Whether the files folder is indexed now: sizes come from the index. */
  readonly indexed: () => Promise<boolean>;
  /**
   * The storage provider's recycle folder virtual path, when configured.
   * A requested path that is the trash folder itself, or nested under it,
   * is answered as `{ indexed: false }`, mirroring how `fs/routes.ts` hides
   * it from listings and `search/service.ts` excludes it from hits.
   */
  readonly trashPathForStorage?: (storage: StorageProvider) => string | null;
}

const NOT_INDEXED: Omit<FolderSizeResponse, "path"> = {
  bytes: 0,
  files: 0,
  indexed: false,
};

/** `Shared with me`: in the home it is a reserved name, so the home's own folder of that name is never counted. */
const SHELF = `/${SHARED_WITH_ME}`;

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
      !(region.scope.virtualPrefix === "/" && isWithin(SHELF, region.virtualPrefix)) &&
      (trashPath === null ||
        (region.virtualPrefix !== trashPath && !isUnderPath(trashPath, region.virtualPrefix))),
  );

  return regionScopes.map((region) => {
    const boundaries = scopes
      .filter((scope) => isUnderPath(region.virtualPrefix, scope.virtualPrefix))
      .map((scope) => scope.virtualPrefix);
    if (trashPath !== null && isUnderPath(region.virtualPrefix, trashPath))
      boundaries.push(trashPath);
    if (region.scope.virtualPrefix === "/" && isUnderPath(region.virtualPrefix, SHELF))
      boundaries.push(SHELF);

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
 * Registers `GET /fs/folder-size?path=`: resolves the virtual `path` to its
 * physical regions via the caller's scopes, resolved for this request, and
 * adds up what the index holds there. The scopes are the permission: no
 * storage is read. Each physical aggregate excludes the trees shadowed by
 * more-specific mappings, the home's own `Shared with me` and the Trash;
 * folders shared with the caller are added back.
 *
 * Answers `200 { indexed: false, bytes: 0, files: 0 }` (never an error) for
 * a folder that is out of scope, the trash folder, or any folder while the
 * files folder is not indexed: none of those is information worth surfacing as a 4xx to a
 * caller who otherwise still has read access, and each is indistinguishable
 * from "this folder was simply never indexed" from the caller's point of
 * view. A folder gone from disk since it was indexed is sized from what the
 * index still holds until the next index pass.
 */
export function registerFolderSizeRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: FolderSizeRoutesDeps,
): void {
  const { authed } = groups;

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
    if (!(await deps.indexed())) {
      return notIndexed();
    }
    const scopes = await deps.resolver.scopesFor(principal.username);
    const regions = sizeRegions(scopes, path, trashPath ?? null);
    if (regions.length === 0) {
      return notIndexed();
    }

    const scopePrefixes = indexPrefixes(scopes);
    const sizes = await Promise.all(
      regions.map((region) =>
        region.excludedRelativePrefixes.length === 0
          ? deps.indexQueries.subtreeSize(scopePrefixes, INDEX_ROOT_ID, region.relativePrefix)
          : deps.indexQueries.subtreeSize(
              scopePrefixes,
              INDEX_ROOT_ID,
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
