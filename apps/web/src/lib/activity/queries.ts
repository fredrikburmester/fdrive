"use client";

import type { PersonalActivityFilters } from "@fdrive/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useMe } from "@/lib/api/auth-queries";
import { queryKeys } from "@/lib/api/keys";
import { activityFeed, activityFile, activityLocations, resolveActivityFile } from "./api";

/**
 * One feed of the caller's history, refreshed whenever the server records a
 * new event. A `null` scope loads nothing yet but still listens, so a file
 * whose history is being recorded right now resolves once it lands.
 */
export function useActivityHistory(
  filters: Partial<PersonalActivityFilters>,
  scope: string | null = "",
) {
  const { data: me } = useMe();
  const accountId = me?.account.id ?? "";
  const client = useQueryClient();
  useEffect(() => {
    if (!accountId) return;
    const stream = new EventSource("/api/v1/activity/stream");
    let timer: ReturnType<typeof setTimeout> | undefined;
    stream.addEventListener("activity", () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void client.invalidateQueries({ queryKey: queryKeys.activity.all(accountId) });
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      stream.close();
    };
  }, [accountId, client]);
  return useInfiniteQuery({
    queryKey: queryKeys.activity.feed(accountId, filters, scope),
    enabled: !!accountId && scope !== null,
    refetchInterval: 10_000,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      activityFeed({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }, scope ?? ""),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
export function useActivityFile(id: string) {
  const { data: me } = useMe();
  return useQuery({
    queryKey: queryKeys.activity.file(me?.account.id ?? "", id),
    enabled: !!me,
    queryFn: () => activityFile(id),
  });
}
/** The history ID at a path of the tab's login; `null` until something there is recorded. */
export function useActivityFileAt(identityId: string | undefined, path: string) {
  const { data: me } = useMe();
  return useQuery({
    queryKey: queryKeys.activity.resolve(me?.account.id ?? "", identityId ?? "", path),
    enabled: !!me && !!identityId,
    queryFn: () => resolveActivityFile(identityId ?? "", path),
  });
}
export function useActivityLocations() {
  const { data: me } = useMe();
  return useQuery({
    queryKey: [...queryKeys.activity.all(me?.account.id ?? ""), "locations"],
    enabled: !!me,
    queryFn: activityLocations,
  });
}
