"use client";

import { useQuery } from "@tanstack/react-query";
import { publicShareClient } from "./client";

export const publicShareKey = (id: string) => ["public-share", id] as const;

export const publicShareMetadataKey = (id: string, generation: number) =>
  [...publicShareKey(id), generation, "metadata"] as const;

export function usePublicShare(id: string, generation: number) {
  return useQuery({
    queryKey: publicShareMetadataKey(id, generation),
    queryFn: ({ signal }) => publicShareClient(signal).publicShare(id),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}

export function useShareEntries(id: string, path: string, generation: number, enabled: boolean) {
  return useQuery({
    queryKey: [...publicShareKey(id), generation, "entries", path],
    queryFn: ({ signal }) => publicShareClient(signal).shareEntries(id, path),
    enabled,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}

/**
 * Loads an archive's entries for `PublicArchivePeek`, without extracting it. `path` is the
 * archive's own path within the share (or "/" for a single-file archive share, matching
 * `GET /public/shares/:id/archive-entries`'s own convention).
 */
export function useShareArchiveEntries(id: string, path: string, generation: number) {
  return useQuery({
    queryKey: [...publicShareKey(id), generation, "archive-entries", path],
    queryFn: ({ signal }) => publicShareClient(signal).shareArchiveEntries(id, path),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}
