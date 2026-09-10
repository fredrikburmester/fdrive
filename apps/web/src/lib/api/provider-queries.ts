"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

/** How long the public provider list stays fresh: it changes only when an administrator edits System > Storage. */
const PROVIDERS_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * The enabled storage providers with their credential forms, from the
 * public `GET /api/v1/providers`. Powers the login page's provider picker
 * and the account page's Add and Remove login dialogs.
 */
export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers.list(),
    queryFn: () => apiClient.providers(),
    staleTime: PROVIDERS_STALE_TIME_MS,
  });
}
