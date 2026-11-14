"use client";

import type { ImageSearchResponse, SearchResponse, SearchStatusResponse } from "@fdrive/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./deps";
import { chipsToQueryParams, type SearchChipState } from "./filters";

/** Delay between retries while the indexer registers the files folder after deployment. */
export const SEARCH_STARTUP_RETRY_MS = 5_000;

/** True for a scope failure the status names: configuration, which waiting does not fix. */
export function isPermanentSearchStatus(status: SearchStatusResponse | undefined): boolean {
  return status?.available === false && status.reason !== undefined;
}

/**
 * True when the files folder is not indexed at all. No waiting changes
 * that, so the copy says what search needs instead.
 */
export function isSearchUnsupported(status: SearchStatusResponse | undefined): boolean {
  return status?.available === false && status.reason === "no_roots";
}

/** The search button's tooltip for a permanent failure: short, and about the index when that is the cause. */
export function searchUnavailableHint(status: SearchStatusResponse | undefined): string {
  return isSearchUnsupported(status) ? "Your files are not indexed" : "Search index is unavailable";
}

/** User-facing wording for unavailable text or visual search. */
export function searchUnavailableMessage(status: SearchStatusResponse | undefined): string {
  return isSearchUnsupported(status)
    ? "Search is not available. Your files are not indexed."
    : "Search is not available.";
}

/**
 * Retries an unavailable result unless the status already identifies a
 * permanent scope failure. A healthy status can still precede index root
 * registration, so an unavailable result remains retryable in that case.
 */
export function shouldRetryUnavailableResult(
  response: Pick<SearchResponse | ImageSearchResponse, "unavailable"> | undefined,
  status: SearchStatusResponse | undefined,
): boolean {
  return response?.unavailable === true && !isPermanentSearchStatus(status);
}

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
  /** Polls only an unavailable response while the caller remains active. */
  readonly retryUnavailable?: boolean;
  /** Current scope status, used to stop retries for permanent failures. */
  readonly status?: SearchStatusResponse | undefined;
  /** The active login, so a switch never shows another login's cached results. */
  readonly identityId?: string | undefined;
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

  return useQuery<SearchResponse>({
    queryKey: [...searchQueryKey(query, chips, currentFolder), options.identityId ?? null],
    queryFn: () =>
      apiClient.search(query, {
        limit: 20,
        ...(params.ext !== undefined ? { ext: params.ext } : {}),
        ...(params.folder !== undefined ? { folder: params.folder } : {}),
      }),
    enabled: (options.enabled ?? true) && trimmed.length > 0,
    refetchInterval: (query) =>
      options.retryUnavailable && shouldRetryUnavailableResult(query.state.data, options.status)
        ? SEARCH_STARTUP_RETRY_MS
        : false,
  });
}

export interface UseImageSearchResultsOptions {
  /** Skips fetching while `false`, for a closed panel, an empty query, or non-image types. Defaults to `true`. */
  readonly enabled?: boolean | undefined;
  readonly identityId?: string | undefined;
  /** Polls only an unavailable response while the caller remains active. */
  readonly retryUnavailable?: boolean | undefined;
  /** Current scope status, used to stop retries for permanent failures. */
  readonly status?: SearchStatusResponse | undefined;
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
    refetchInterval: (queryState) =>
      options.retryUnavailable &&
      shouldRetryUnavailableResult(queryState.state.data, options.status)
        ? SEARCH_STARTUP_RETRY_MS
        : false,
  });
}

/**
 * Whether search is configured at all and whether semantic search is up.
 * Cached for a minute since this rarely changes within a session; used to
 * disable the search trigger with a tooltip when the index is not
 * configured.
 */
export function useSearchStatus() {
  return useQuery<SearchStatusResponse>({
    queryKey: searchStatusQueryKey(),
    queryFn: () => apiClient.searchStatus(),
    staleTime: 60_000,
  });
}
