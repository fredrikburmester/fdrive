import type { ImageSearchHit, ImageSearchResponse } from "@fdrive/contracts";
import { baseName, extensionOf, mimeFromExtension, type Scope } from "@fdrive/core";
import type { IndexQueries } from "@fdrive/db";
import { roundTripVirtualPath } from "../scoping/round-trip.ts";
import type { SidecarResult } from "../system/sidecar-client.js";
import type { ImageEmbedClient, ImageEmbedHealthInfo } from "./image-embed-client.js";
import { indexPrefixes, reservedExclusion } from "./scopes.js";

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
  readonly indexQueries: Pick<IndexQueries, "searchImages">;
  /** `null` when `FDRIVE_ML_URL` is not configured; image search never runs then. */
  readonly imageEmbedClient: ImageEmbedClient | null;
  /**
   * Resolves the sidecar's cached health (`{status, model, dim, device}` or
   * a `SidecarResult` failure), reused for 15s across requests (see
   * `createCachedProbe`) so the health check is not repeated on every
   * keystroke. `null` (rather than a rejected promise) when `imageEmbedClient`
   * is itself `null`.
   */
  readonly resolveHealth: () => Promise<SidecarResult<ImageEmbedHealthInfo> | null>;
  /**
   * Same rule as `SearchServiceDeps.trashPath`: the query leaves fdrive's
   * own folders out before its limit. A test/default value; production passes a
   * request snapshot.
   */
  readonly trashPath?: string | null;
  readonly clock: () => Date;
}

export interface ImageSearchServiceInput {
  readonly trashPath?: string | null;
  readonly scopes: readonly Scope[];
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
 * against the image-embed sidecar, round-trips every
 * `IndexQueries.searchImages` row through the caller's scopes (which are the
 * permission, exactly as for text search), then ranks what is left with
 * `selectImageHits`, so a page is full whenever there are enough matches. `unavailable: true` covers three distinct causes (no verified
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

      const embedded = await deps.imageEmbedClient.embedText(input.query);
      if (embedded === null) {
        return unavailableResponse(input.query, tookMs());
      }

      const rows = await deps.indexQueries.searchImages(
        indexPrefixes(input.scopes),
        embedded.vector,
        health.data.model,
        IMAGE_SEARCH_FANOUT_LIMIT,
        { exclude: reservedExclusion(input.scopes, trashPath) },
      );
      const fanoutCut = rows.length >= IMAGE_SEARCH_FANOUT_LIMIT;

      const visible = rows.flatMap((row) => {
        const path = roundTripVirtualPath(input.scopes, row.path);
        return path === null ? [] : [{ ...row, path }];
      });
      const hits = selectImageHits(visible, input.limit).map((row): ImageSearchHit => {
        const name = baseName(row.path);
        const ext = extensionOf(name);
        return {
          path: row.path,
          name,
          ext,
          mime: mimeFromExtension(ext),
          size: row.size,
          modifiedAt: row.modifiedAt.toISOString(),
          score: row.score,
        };
      });

      return {
        query: input.query,
        hits,
        unavailable: false,
        ...(fanoutCut && { partial: true }),
        tookMs: tookMs(),
      };
    },
  };
}
