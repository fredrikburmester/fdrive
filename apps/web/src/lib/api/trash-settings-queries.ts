"use client";

import type { TrashSettingsUpdateRequest } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

export function useSystemTrash(enabled = true) {
  return useQuery({
    queryKey: queryKeys.system.trash(),
    queryFn: () => apiClient.systemTrash(),
    enabled,
  });
}

export function useUpdateTrashSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TrashSettingsUpdateRequest) => apiClient.systemUpdateTrash(input),
    onSuccess: async (data) => {
      client.setQueryData(queryKeys.system.trash(), data);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["trash"] }),
        client.invalidateQueries({ queryKey: ["fs"] }),
        client.invalidateQueries({ queryKey: ["search"] }),
      ]);
    },
  });
}
