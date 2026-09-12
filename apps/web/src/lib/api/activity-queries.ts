"use client";

import type { SystemActivityId } from "@fdrive/contracts";
import { useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

export function activitySections(meta: Record<string, unknown> | undefined): SystemActivityId[] {
  return (meta?.systemActivity as SystemActivityId[] | undefined) ?? [];
}

/** Mounted only by the admin sidebar. Mutation keys remain available for admission checks. */
export function useSystemActivity() {
  const client = useQueryClient();
  const [accepted, setAccepted] = useState<{ sections: SystemActivityId[]; at: number }[]>([]);
  const pending = useMutationState({
    filters: {
      status: "pending",
      predicate: (mutation) => activitySections(mutation.meta).length > 0,
    },
    select: (mutation) => activitySections(mutation.meta),
  }).flat();
  const query = useQuery({
    queryKey: queryKeys.system.activity(),
    queryFn: async () => {
      const requestedAt = Date.now();
      return { ...(await apiClient.systemActivity()), requestedAt };
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  useEffect(
    () =>
      client.getMutationCache().subscribe((event) => {
        if (
          event.type !== "updated" ||
          (event.action.type !== "success" && event.action.type !== "error")
        )
          return;
        const sections = activitySections(event.mutation.meta);
        if (!sections.length) return;
        if (
          event.action.type === "success" &&
          event.mutation.meta?.systemActivityBackground === true
        ) {
          const at = Date.now();
          setAccepted((current) => [
            ...current.filter((entry) => at - entry.at < 15000),
            { sections, at },
          ]);
        }
        void client.invalidateQueries({ queryKey: queryKeys.system.activity() });
      }),
    [client],
  );
  const requestedAt = query.data?.requestedAt ?? 0;
  const starting = (query.isError ? [] : accepted)
    .filter((entry) => entry.at + 2000 > requestedAt && Date.now() - entry.at < 15000)
    .flatMap((entry) => entry.sections)
    .filter((id) => !query.data?.items.some((item) => item.id === id && item.state === "working"));
  return { ...query, pending: new Set([...pending, ...starting]) };
}
