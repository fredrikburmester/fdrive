import {
  ImageSearchQuery,
  type ImageSearchResponse,
  ROUTES,
  SearchQuery,
  type SearchResponse,
  type SearchStatusResponse,
} from "@fdrive/contracts";
import { parseSearchFilters, type StorageProvider } from "@fdrive/core";
import type { IdentityRepo } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import { ApiHttpError } from "../errors.js";
import { createReadAuthorizer } from "../scoping/read-authorizer.ts";
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
  readonly resolver: Pick<ScopeResolver, "verifiedIndexScopes" | "status">;
  readonly identities: Pick<IdentityRepo, "get">;
  /** Whether `FDRIVE_EMBED_URL` is configured; `search/status` reports this directly. */
  readonly semanticEnabled: boolean;
  /** Whether `FDRIVE_IMAGE_EMBED_URL` is configured; `search/status` reports this directly. */
  readonly imageSearchEnabled: boolean;
  readonly trashPathForStorage?: (storage: StorageProvider) => string | null;
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
 * optional. Both routes resolve the caller's *verified* index scopes fresh
 * on every request (never cached client-side, never a caller-supplied
 * override); when unavailable, `search` still responds 200 with
 * `unavailable: true` rather than an error, so the web UI can disable the
 * search entry point instead of showing a failure.
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

    const identity = await deps.identities.get(principal.identityId);
    const verified =
      identity === null
        ? { available: false as const }
        : await deps.resolver.verifiedIndexScopes(identity);
    const authorizer = createReadAuthorizer({ storage: principal.storage });

    const trashPath = deps.trashPathForStorage?.(principal.storage);
    const response = await deps.searchService.search({
      ...(trashPath === undefined ? {} : { trashPath }),
      scopes: verified.available ? verified.scopes : [],
      authorizer,
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

    const identity = await deps.identities.get(principal.identityId);
    const verified =
      identity === null
        ? { available: false as const }
        : await deps.resolver.verifiedIndexScopes(identity);
    const authorizer = createReadAuthorizer({ storage: principal.storage });

    const trashPath = deps.trashPathForStorage?.(principal.storage);
    const response = await deps.imageSearchService.search({
      ...(trashPath === undefined ? {} : { trashPath }),
      scopes: verified.available && features?.imageSearch !== false ? verified.scopes : [],
      authorizer,
      query: result.data.q,
      limit,
    });

    const body: ImageSearchResponse = response;
    return c.json(body);
  });

  authed.get(routePath(ROUTES.search.status), async (c) => {
    const features = await deps.features?.();
    const principal = c.get("principal");
    const identity = await deps.identities.get(principal.identityId);
    const status =
      identity === null ? null : await deps.resolver.status(identity, principal.isAdmin);
    const body: SearchStatusResponse = {
      available:
        status?.status === "available" &&
        (features === undefined || features.textSearch || features.imageSearch),
      semantic: deps.semanticEnabled && features?.semanticSearch !== false,
      images: deps.imageSearchEnabled && features?.imageSearch !== false,
      ...(status?.status === "unavailable" ? { reason: status.reason } : {}),
    };
    return c.json(body);
  });
}
