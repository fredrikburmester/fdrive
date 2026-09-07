import type { ArchiveEntriesResponse } from "@fdrive/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/preview/deps";

/**
 * `GET /fs/archive-entries`'s query key, keyed by the archive's own path.
 * Kept here (rather than added to `lib/api/keys.ts`'s central `queryKeys`
 * factory, which every other fs query key lives in) because this chunk's
 * scope does not include that file; wiring `archiveEntriesKey` in as
 * `queryKeys.fs.archiveEntries` there is a natural follow-up.
 */
export function archiveEntriesKey(path: string): readonly ["fs", "archiveEntries", string] {
  return ["fs", "archiveEntries", path] as const;
}

/** Loads an archive's entries for `ArchivePreview`, without extracting it. */
export function useArchiveEntries(path: string) {
  return useQuery<ArchiveEntriesResponse>({
    queryKey: archiveEntriesKey(path),
    queryFn: () => apiClient.archiveEntries(path),
  });
}
