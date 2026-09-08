"use client";

import type { AccountSearchResponse, ImageSearchResponse, SearchResponse } from "@fdrive/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./deps";
import { chipsToQueryParams, type SearchChipState } from "./filters";

/** TanStack Query key for `useSearchResults`, stable across chip/folder combinations. */
export function searchQueryKey(query: string, chips: SearchChipState, currentFolder: string) {
  const params = chipsToQueryParams(chips, currentFolder);
  return ["search", "results", query, params.ext ?? null, params.folder ?? null] as const;
}

/** TanStack Query key for `useSearchStatus`. */
export function searchStatusQueryKey() {
  return ["search", "status"] as const;
}

/** TanStack Query key for `useImageSearchResults`, stable across the same query text and active identity. */
export function imageSearchQueryKey(query: string, identityId?: string) {
  return ["search", "images", query, identityId ?? null] as const;
}

export interface UseSearchResultsOptions {
  /** Skips fetching while `false`, for a closed panel or an empty query. Defaults to `true`. */
  readonly enabled?: boolean;
  readonly scope?: {
    readonly accountId: string;
    readonly identityId: string;
    readonly all: boolean;
  };
}

/**
 * Runs the hybrid search for `query`, restricted by `chips` and (when
 * "this folder only" is on) `currentFolder`. Disabled for a blank query, so
 * opening the panel with nothing typed never fires a request.
 */
export function useSearchResults(
  query: string,
  chips: SearchChipState,
  currentFolder: string,
  options: UseSearchResultsOptions = {},
) {
  const params = chipsToQueryParams(chips, currentFolder);
  const trimmed = query.trim();

  return useQuery<SearchResponse | AccountSearchResponse>({
    queryKey: [...searchQueryKey(query, chips, currentFolder), options.scope ?? null],
    queryFn: () =>
      (options.scope?.all ? apiClient.accountSearch : apiClient.search)(query, {
        limit: 20,
        ...(params.ext !== undefined ? { ext: params.ext } : {}),
        ...(params.folder !== undefined ? { folder: params.folder } : {}),
      }),
    enabled: (options.enabled ?? true) && trimmed.length > 0,
  });
}

export interface UseImageSearchResultsOptions {
  /** Skips fetching while `false`, for a closed panel, an empty query, or non-image types. Defaults to `true`. */
  readonly enabled?: boolean | undefined;
  readonly identityId?: string | undefined;
}

/**
 * Runs image-content search for `query` (matching a thumbnail's embedding
 * to the query text), only while `options.enabled` is true and `query` is
 * non-blank.
 */
export function useImageSearchResults(query: string, options: UseImageSearchResultsOptions = {}) {
  const trimmed = query.trim();

  return useQuery<ImageSearchResponse>({
    queryKey: imageSearchQueryKey(query, options.identityId),
    queryFn: () => apiClient.searchImages(query, { limit: 24 }),
    enabled: (options.enabled ?? true) && trimmed.length > 0,
  });
}

/**
 * Whether search is configured at all and whether semantic search is up.
 * Cached for a minute since this rarely changes within a session; used to
 * disable the search trigger with a tooltip when the index is not
 * configured.
 */
export function useSearchStatus() {
  return useQuery({
    queryKey: searchStatusQueryKey(),
    queryFn: () => apiClient.searchStatus(),
    staleTime: 60_000,
  });
}
