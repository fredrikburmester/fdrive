"use client";

import type { TrashSettingsUpdateRequest } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

/** The Trash settings of one storage server. */
export function useSystemTrash(providerId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.system.trash(providerId),
    queryFn: () => apiClient.systemTrash(providerId),
    enabled,
  });
}

export function useUpdateTrashSettings() {
  const client = useQueryClient();
  return useMutation({
    meta: { systemActivity: ["storage"], systemActivityBackground: false },
    mutationFn: (input: TrashSettingsUpdateRequest) => apiClient.systemUpdateTrash(input),
    onSuccess: async (data) => {
      client.setQueryData(queryKeys.system.trash(data.providerId), data);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["trash"] }),
        // Each login's `capabilities.trash` (sidebar Trash, "Move to Trash") follows this setting.
        client.invalidateQueries({ queryKey: queryKeys.auth.me() }),
        client.invalidateQueries({ queryKey: ["fs"] }),
        client.invalidateQueries({ queryKey: ["search"] }),
      ]);
    },
  });
}
