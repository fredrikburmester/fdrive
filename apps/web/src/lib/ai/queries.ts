"use client";

import type {
  AiSettingsUpdateRequest,
  MoveManyRequest,
  MoveManyResponse,
  OrganizeRequest,
} from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { useFsMutation } from "@/lib/files/queries";

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

/** `path` and each folder above it except the root, so every listing up to `/` is refreshed. */
function withAncestors(path: string): string[] {
  const paths = [path];
  for (let folder = parentPath(path); folder !== "/"; folder = parentPath(folder))
    paths.push(folder);
  return paths;
}

/**
 * Applies a batch of moves for the login that opened the review, and
 * refreshes every folder they touched. Missing destination folders may be
 * created several levels deep, so every listing above each target is
 * refreshed too. Failures are reported by the caller.
 */
export function useMoveMany() {
  return useFsMutation<MoveManyRequest, MoveManyResponse>({
    mutationFn: (request, client) => client.moveMany(request),
    toAffected: (_request, response) => {
      const moved = response.results.filter((result) => result.ok);
      return {
        op: "move",
        paths: moved.map((result) => result.path),
        targets: moved.flatMap((result) => withAncestors(result.target)),
      };
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
