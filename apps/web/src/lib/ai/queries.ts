"use client";

import type {
  AiSettingsUpdateRequest,
  MoveManyRequest,
  MoveManyResponse,
  OrganizeRequest,
} from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { refreshIdentityQuery } from "@/lib/account/invalidation";
import { apiClient, snapshotTabApiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { affectedListKeys } from "@/lib/files/queries";

/** While a run is in progress, how often its activity is refreshed. */
export const ORGANIZE_POLL_MS = 1000;

/** Whether AI actions can be offered to the signed-in person. */
export function useAiStatus() {
  return useQuery({
    queryKey: queryKeys.ai.status(),
    queryFn: () => apiClient.aiStatus(),
    staleTime: 60_000,
  });
}

export function useStartOrganize() {
  return useMutation({
    mutationFn: (request: OrganizeRequest) => apiClient.startOrganize(request),
  });
}

/** Polls one run until it finishes. */
export function useOrganizeRun(id: string | null) {
  return useQuery({
    queryKey: queryKeys.ai.run(id ?? ""),
    // `enabled` keeps this from running without an id.
    queryFn: () => apiClient.organizeRun(id as string),
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.state === "running" ? ORGANIZE_POLL_MS : false),
  });
}

export function useCancelOrganize() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.cancelOrganize(id),
    onSuccess: (run) => client.setQueryData(queryKeys.ai.run(run.id), run),
  });
}

/**
 * Applies a batch of moves and refreshes every folder they touched,
 * including the parents of folders the batch created.
 */
export function useMoveMany() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: MoveManyRequest) => snapshotTabApiClient().moveMany(request),
    onSuccess: (response: MoveManyResponse) => {
      const moved = response.results.filter((result) => result.ok);
      const keys = affectedListKeys({
        op: "move",
        paths: moved.map((result) => result.path),
        targets: [
          ...moved.map((result) => result.target),
          ...moved.map((result) => parentPath(result.target)),
        ],
      });
      for (const key of keys) void refreshIdentityQuery(client, key);
      if (moved.length > 0) void refreshIdentityQuery(client, queryKeys.folderViews.all());
    },
  });
}

export function useSystemAi() {
  return useQuery({
    queryKey: queryKeys.system.ai(),
    queryFn: () => apiClient.systemAi(),
  });
}

export function useUpdateSystemAi() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AiSettingsUpdateRequest) => apiClient.systemUpdateAi(input),
    onSuccess: async (data) => {
      client.setQueryData(queryKeys.system.ai(), data);
      await client.invalidateQueries({ queryKey: queryKeys.ai.status() });
    },
  });
}

export function useTestSystemAi() {
  return useMutation({
    mutationFn: () => apiClient.systemTestAi(),
  });
}
