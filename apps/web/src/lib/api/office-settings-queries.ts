"use client";

import type { OfficeSettingsUpdateRequest } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

export function useSystemOffice() {
  return useQuery({
    queryKey: queryKeys.system.office(),
    queryFn: () => apiClient.systemOffice(),
    refetchInterval: (query) => (query.state.data?.configuration.enabled ? 5000 : false),
  });
}

export function useUpdateOfficeSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: OfficeSettingsUpdateRequest) => apiClient.systemUpdateOffice(input),
    onSuccess: async (data) => {
      client.setQueryData(queryKeys.system.office(), data);
      await client.invalidateQueries({ queryKey: ["office"] });
    },
  });
}
