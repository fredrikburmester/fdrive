import type { ImageSearchHit, ImageSearchResponse } from "@fdrive/contracts";
import { baseName, extensionOf, isUnderPath, mimeFromExtension, type Scope } from "@fdrive/core";
import type { ImageSearchHit as DbImageSearchHit, IndexQueries, ScopePrefix } from "@fdrive/db";
import type { ReadAuthorizer } from "../scoping/read-authorizer.ts";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import type { SidecarResult } from "../system/sidecar-client.js";
import type { ImageEmbedClient, ImageEmbedHealthInfo } from "./image-embed-client.js";

/**
 * Rows fanned out from `IndexQueries.searchImages` before ranking. Matches
 * the text-search service's `CONTENT_FANOUT_LIMIT`'s role: bounded so one
 * query can never scan an unbounded number of embedded thumbnails.
 */
export const IMAGE_SEARCH_FANOUT_LIMIT = 60;

/**
 * A row is kept only while its cosine score is at least this fraction of the
 * best (first) row's score, when that best score is positive. CLIP/SigLIP
 * cosine scores are not comparable across queries (a good match for one
 * query can score lower than a poor match for another), so cutting is
 * always relative to the top hit for the *same* query, never an absolute
 * threshold.
 */
export const IMAGE_SCORE_RATIO = 0.6;

/** The image-embed sidecar's SigLIP 2 model dimension; rows or health from any other dim are ignored. */
export const IMAGE_EMBED_DIM = 1024;

/**
 * Keeps only the rows (already ranked best-first by `searchImages`) that
 * pass the ratio rule, then caps the result at `limit`. When the best row's
 * score is positive, a row is dropped once its score falls below
 * `best * IMAGE_SCORE_RATIO`; there is never an absolute cosine threshold.
 * When the best score is zero or negative (a ratio would invert the
 * ordering), only the top `limit` rows are kept instead. Pure and exported
 * for direct unit testing.
 */
export function selectImageHits<T extends { readonly score: number }>(
  rows: readonly T[],
  limit: number,
): T[] {
  const best = rows[0];
  if (best === undefined) {
    return [];
  }
  if (best.score <= 0) {
    return rows.slice(0, limit);
  }
  const threshold = best.score * IMAGE_SCORE_RATIO;
  return rows.filter((row) => row.score >= threshold).slice(0, limit);
}

export interface ImageSearchServiceDeps {
  readonly enabled?: () => Promise<boolean>;
  readonly indexQueries: Pick<IndexQueries, "searchImages" | "rootIdsByName">;
  /** `null` when `FDRIVE_IMAGE_EMBED_URL` is not configured; image search never runs then. */
  readonly imageEmbedClient: ImageEmbedClient | null;
  /**
   * Resolves the sidecar's cached health (`{status, model, dim, device}` or
   * a `SidecarResult` failure), reused for 15s across requests (see
   * `createCachedProbe`) so the health check is not repeated on every
   * keystroke. `null` (rather than a rejected promise) when `imageEmbedClient`
   * is itself `null`.
   */
  readonly resolveHealth: () => Promise<SidecarResult<ImageEmbedHealthInfo> | null>;
  /** Same trash-exclusion rule as `SearchServiceDeps.trashPath`. */
  /** Optional test/default value; production passes a request snapshot. */
  readonly trashPath?: string | null;
  readonly clock: () => Date;
}

export interface ImageSearchServiceInput {
  readonly trashPath?: string | null;
  readonly scopes: readonly Scope[];
  readonly authorizer: ReadAuthorizer;
  readonly query: string;
  readonly limit: number;
}

export interface ImageSearchService {
  search(input: ImageSearchServiceInput): Promise<ImageSearchResponse>;
}

function elapsedMs(clock: () => Date, startedAt: Date): number {
  return Math.max(0, clock().getTime() - startedAt.getTime());
}

function unavailableResponse(
  query: string,
  tookMs: number,
  opts?: { partial?: boolean },
): ImageSearchResponse {
  return {
    query,
    hits: [],
    unavailable: true,
    ...(opts?.partial === true ? { partial: true } : {}),
    tookMs,
  };
}

/**
 * Builds the image-content search service: resolves the query's embedding
 * against the image-embed sidecar, ranks `IndexQueries.searchImages` rows
 * with `selectImageHits`, and round-trips plus live-read checks every
 * candidate before it can appear in a hit, exactly like the text search
 * service. `unavailable: true` covers three distinct causes (no verified
 * scope, image search not configured, or no embedding for this query); the
 * caller cannot tell which from the response alone, only that there is
 * nothing to search or show.
 */
export function createImageSearchService(deps: ImageSearchServiceDeps): ImageSearchService {
  return {
    async search(input: ImageSearchServiceInput): Promise<ImageSearchResponse> {
      const trashPath = input.trashPath ?? deps.trashPath ?? null;
      if (deps.enabled !== undefined && !(await deps.enabled()))
        return unavailableResponse(input.query, 0);
      const startedAt = deps.clock();
      const tookMs = () => elapsedMs(deps.clock, startedAt);

      if (input.scopes.length === 0 || deps.imageEmbedClient === null) {
        return unavailableResponse(input.query, tookMs());
      }

      const health = await deps.resolveHealth();
      if (
        health === null ||
        !health.ok ||
        health.data.status !== "ok" ||
        health.data.dim !== IMAGE_EMBED_DIM
      ) {
        return unavailableResponse(input.query, tookMs());
      }

      const rootIds = await deps.indexQueries.rootIdsByName();
      const rootNameById = new Map<number, string>();
      for (const [name, id] of Object.entries(rootIds)) {
        rootNameById.set(id, name);
      }

      const prefixes: ScopePrefix[] = [];
      for (const scope of input.scopes) {
        const rootId = rootIds[scope.rootName];
        if (rootId !== undefined) {
          prefixes.push({ rootId, fsPrefix: scope.fsPrefix });
        }
      }
      if (prefixes.length === 0) {
        return unavailableResponse(input.query, tookMs());
      }

      const embedded = await deps.imageEmbedClient.embedText(input.query);
      if (embedded === null) {
        return unavailableResponse(input.query, tookMs());
      }

      const rows = await deps.indexQueries.searchImages(
        prefixes,
        embedded.vector,
        health.data.model,
        IMAGE_SEARCH_FANOUT_LIMIT,
      );
      const fanoutCut = rows.length >= IMAGE_SEARCH_FANOUT_LIMIT;
      const ranked = selectImageHits(rows, input.limit);

      function virtualPathFor(row: DbImageSearchHit): string | null {
        const rootName = rootNameById.get(row.rootId);
        if (rootName === undefined) {
          return null;
        }
        const virtualPath = roundTripVirtualPath(input.scopes, rootName, row.path);
        if (virtualPath === null) {
          return null;
        }
        if (
          trashPath !== null &&
          (virtualPath === trashPath || isUnderPath(trashPath, virtualPath))
        ) {
          return null;
        }
        return virtualPath;
      }

      let authUnavailable = false;

      const resolvedHits = await Promise.all(
        ranked.map(async (row): Promise<ImageSearchHit | null> => {
          const virtualPath = virtualPathFor(row);
          if (virtualPath === null) {
            return null;
          }
          const authResult = await input.authorizer.authorize({ path: virtualPath, kind: "file" });
          if (!authResult.allowed) {
            if (authResult.reason === "unavailable") {
              authUnavailable = true;
            }
            return null;
          }
          const name = baseName(virtualPath);
          const ext = extensionOf(name);
          return {
            path: virtualPath,
            name,
            ext,
            mime: mimeFromExtension(ext),
            size: row.size,
            modifiedAt: row.modifiedAt.toISOString(),
            score: row.score,
          };
        }),
      );

      const hits = resolvedHits.filter((hit): hit is ImageSearchHit => hit !== null);

      return {
        query: input.query,
        hits,
        unavailable: false,
        ...((fanoutCut || authUnavailable) && { partial: true }),
        tookMs: tookMs(),
      };
    },
  };
}
