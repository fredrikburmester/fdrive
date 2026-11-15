"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";

/** The signed-in login's own folder: bytes used, its limit, kinds and largest files. */
export function useStorageUsage() {
  return useQuery({
    queryKey: queryKeys.storage.usage(),
    queryFn: () => apiClient.storageUsage(),
  });
}
