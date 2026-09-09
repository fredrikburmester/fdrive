"use client";

import type { SystemLogLevel, SystemLogSubsystem } from "@fdrive/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

/** How often an open log sheet re-polls; closed sheets do not fetch at all. */
export const SYSTEM_LOGS_REFETCH_INTERVAL_MS = 5000;

/**
 * Pages through one subsystem's log, newest first. Each page's `nextCursor`
 * (the oldest entry's timestamp) becomes the next page's `before`. Polling
 * refetches every loaded page, which is acceptable at 200 entries a page.
 */
export function useSystemLogs(
  subsystem: SystemLogSubsystem,
  options: { level: SystemLogLevel; enabled: boolean },
) {
  return useInfiniteQuery({
    queryKey: queryKeys.system.logs(subsystem, options.level),
    queryFn: ({ pageParam }) =>
      apiClient.systemLogs(subsystem, {
        level: options.level,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: options.enabled,
    refetchInterval: options.enabled ? SYSTEM_LOGS_REFETCH_INTERVAL_MS : false,
  });
}
