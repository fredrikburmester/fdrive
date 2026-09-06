import {
  ROUTES,
  SearchQuery,
  type SearchResponse,
  type SearchStatusResponse,
} from "@fdrive/contracts";
import { parseSearchFilters } from "@fdrive/core";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import type { SearchService } from "./service.js";

const API_PREFIX = "/api/v1";

/** Strips the `/api/v1` prefix from a `ROUTES.search.*` path, since `authed` is already mounted there. */
function routePath(fullPath: string): string {
  return fullPath.slice(API_PREFIX.length);
}

export interface SearchRoutesDeps {
  readonly searchService: SearchService;
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
 * optional. When the caller has no index-backed scope, `search` still
 * responds 200 with `unavailable: true` rather than an error, so the web UI
 * can disable the search entry point instead of showing a failure.
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
      username: principal.username,
      query: result.data.q,
      filters,
      limit,
    });

    const body: SearchResponse = response;
    return c.json(body);
  });

  authed.get(routePath(ROUTES.search.status), (c) => {
    const body: SearchStatusResponse = deps.searchService.status();
    return c.json(body);
  });
}
