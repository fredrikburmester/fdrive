import {
  ImageSearchQuery,
  type ImageSearchResponse,
  ROUTES,
  SearchQuery,
  type SearchResponse,
  type SearchStatusResponse,
} from "@fdrive/contracts";
import { parseSearchFilters } from "@fdrive/core";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import type { ScopeResolver } from "../scoping/resolver.ts";
import type { ImageSearchService } from "./image-service.js";
import type { SearchService } from "./service.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from a `ROUTES.search.*` path, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface SearchRoutesDeps {
  readonly features?: () => Promise<{
    textSearch: boolean;
    semanticSearch: boolean;
    imageSearch: boolean;
  }>;
  readonly searchService: SearchService;
  readonly imageSearchService: ImageSearchService;
  readonly resolver: Pick<ScopeResolver, "scopesFor">;
  /** Whether `FDRIVE_INDEXER_URL` is configured: without the indexer nothing is indexed. */
  readonly indexerConfigured: boolean;
  /** Whether `FDRIVE_ML_URL` is configured; `search/status` reports this directly. */
  readonly semanticEnabled: boolean;
  /** Whether `FDRIVE_ML_URL` is configured; `search/status` reports this directly. */
  readonly imageSearchEnabled: boolean;
}

/** Default and maximum number of hits returned by `GET /api/v1/search`. */
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

/**
 * Parses the `limit` query parameter: a positive integer clamped to
 * `[1, MAX_SEARCH_LIMIT]`, falling back to `DEFAULT_SEARCH_LIMIT` for a
 * missing, non-numeric, or non-integer value rather than rejecting the
 * request outright.
 */
export function parseSearchLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(parsed, MAX_SEARCH_LIMIT));
}

/**
 * Registers `GET /search` (hybrid search, scoped to the caller's identity)
 * and `GET /search/status` on the authed group. `q` is required (400 for an
 * empty value, enforced by `SearchQuery`'s schema); every other filter is
 * optional. Both routes resolve the caller's scopes fresh on every request
 * (never cached client-side, never a caller-supplied override); when search
 * is unavailable, `search` still responds 200 with `unavailable: true`
 * rather than an error, so the web UI can disable the search entry point
 * instead of showing a failure.
 */
export function registerSearchRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: SearchRoutesDeps,
): void {
  const { authed } = groups;

  authed.get(routePath(ROUTES.search.query), async (c) => {
    const result = SearchQuery.safeParse(c.req.query());
    if (!result.success) {
      throw new ApiHttpError("bad_request", "invalid query", { issues: result.error.issues });
    }
    const principal = c.get("principal");
    const filters = parseSearchFilters(result.data);
    const limit = parseSearchLimit(result.data.limit);

    const response = await deps.searchService.search({
      scopes: deps.indexerConfigured ? await deps.resolver.scopesFor(principal.username) : [],
      query: result.data.q,
      filters,
      limit,
    });

    const body: SearchResponse = response;
    return c.json(body);
  });

  authed.get(routePath(ROUTES.search.images), async (c) => {
    const result = ImageSearchQuery.safeParse(c.req.query());
    if (!result.success) {
      throw new ApiHttpError("bad_request", "invalid query", { issues: result.error.issues });
    }
    const principal = c.get("principal");
    const limit = parseSearchLimit(result.data.limit);
    const features = await deps.features?.();

    const response = await deps.imageSearchService.search({
      scopes:
        deps.indexerConfigured && features?.imageSearch !== false
          ? await deps.resolver.scopesFor(principal.username)
          : [],
      query: result.data.q,
      limit,
    });

    const body: ImageSearchResponse = response;
    return c.json(body);
  });

  authed.get(routePath(ROUTES.search.status), async (c) => {
    const features = await deps.features?.();
    const body: SearchStatusResponse = {
      available:
        deps.indexerConfigured &&
        (features === undefined || features.textSearch || features.imageSearch),
      semantic: deps.semanticEnabled && features?.semanticSearch !== false,
      images: deps.imageSearchEnabled && features?.imageSearch !== false,
      ...(deps.indexerConfigured ? {} : { reason: "not_indexed" as const }),
    };
    return c.json(body);
  });
}
