"use client";

import type { TrashSettings } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

/** How long Trash keeps an item, which the Trash page, the delete dialog and System > General say. */
export function useTrashSettings() {
  return useQuery({
    queryKey: queryKeys.trash.settings(),
    queryFn: () => apiClient.trashSettings(),
  });
}

export function useUpdateTrashSettings() {
  const client = useQueryClient();
  return useMutation({
    meta: { systemActivity: ["general"], systemActivityBackground: false },
    mutationFn: (input: TrashSettings) => apiClient.systemUpdateTrash(input),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.trash.settings(), data);
    },
  });
}
