"use client";

import type { CreateSavedSearchRequest } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient, queryKeys } from "./deps";

/** The caller's saved searches, oldest first. */
export function useSavedSearches() {
  return useQuery({
    queryKey: queryKeys.savedSearches.list(),
    queryFn: async () => (await apiClient.listSavedSearches()).searches,
  });
}

/** Saves and removes the caller's searches, refreshing the list after either. */
export function useSavedSearchMutations() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.savedSearches.list() });
  const create = useMutation({
    mutationFn: (req: CreateSavedSearchRequest) => apiClient.createSavedSearch(req),
    onSuccess: refresh,
    onError: () => toast.error("Could not save the search."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiClient.deleteSavedSearch(id),
    onSuccess: refresh,
    onError: () => toast.error("Could not remove the saved search."),
  });
  return { create, remove };
}
