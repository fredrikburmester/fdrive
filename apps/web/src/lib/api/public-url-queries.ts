"use client";

import type { PublicUrlUpdateRequest } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

export function useSystemPublicUrl() {
  return useQuery({
    queryKey: queryKeys.system.publicUrl(),
    queryFn: () => apiClient.systemPublicUrl(),
  });
}

export function useUpdatePublicUrl() {
  const client = useQueryClient();
  return useMutation({
    meta: { systemActivity: ["general"], systemActivityBackground: false },
    mutationFn: (input: PublicUrlUpdateRequest) => apiClient.systemUpdatePublicUrl(input),
    onSuccess: async (data) => {
      client.setQueryData(queryKeys.system.publicUrl(), data);
      // Office reports readiness against the address the editor is told
      // fdrive lives at, so its status is stale once the address changes.
      await client.invalidateQueries({ queryKey: queryKeys.system.office() });
    },
  });
}
