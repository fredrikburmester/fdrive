"use client";

import type { FolderSizeResponse } from "@fdrive/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";

/**
 * A directory's total size, computed from the index alone (see the API's
 * `GET /fs/folder-size`). `enabled` gates the request so the Inspector only
 * fetches this for a directory, never a file; the query itself never
 * throws for an out-of-scope or not-indexed folder (the route always
 * answers 200 with `indexed: false` for those), so a caller sees a real
 * loading state exactly while the request is in flight.
 */
export function useFolderSize(path: string, opts: { enabled: boolean }) {
  return useQuery<FolderSizeResponse>({
    queryKey: queryKeys.fs.folderSize(path),
    queryFn: () => apiClient.folderSize(path),
    enabled: opts.enabled,
    staleTime: 30_000,
  });
}
