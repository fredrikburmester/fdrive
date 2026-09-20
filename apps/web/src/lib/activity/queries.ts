"use client";

import type { PersonalActivityFilters } from "@fdrive/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useMe } from "@/lib/api/auth-queries";
import { queryKeys } from "@/lib/api/keys";
import { activityFeed, activityFile, activityLocations } from "./api";

export function useActivityHistory(filters: Partial<PersonalActivityFilters>, scope = "") {
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
    enabled: !!accountId,
    refetchInterval: 10_000,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      activityFeed({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }, scope),
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
export function useActivityLocations() {
  const { data: me } = useMe();
  return useQuery({
    queryKey: [...queryKeys.activity.all(me?.account.id ?? ""), "locations"],
    enabled: !!me,
    queryFn: activityLocations,
  });
}
