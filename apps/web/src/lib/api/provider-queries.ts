"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

/** How long the public provider list stays fresh: it changes only when an administrator renames the storage. */
const PROVIDERS_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * The enabled storage with its credential form, from the public
 * `GET /api/v1/providers`. Powers the account page's Add and Remove login
 * dialogs; the login page reads the same list server-side.
 */
export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers.list(),
    queryFn: () => apiClient.providers(),
    staleTime: PROVIDERS_STALE_TIME_MS,
  });
}
