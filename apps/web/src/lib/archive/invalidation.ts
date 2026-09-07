import type { SseEvent } from "@fdrive/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { archiveEntriesKey } from "./queries";

/**
 * Pure extension of `lib/api/sse.ts`'s `keysToInvalidate` (mirroring
 * `lib/metadata/invalidation.ts` and `lib/trash/invalidation.ts`'s own
 * "extra keys for an fs event" modules), for the archive-entries side
 * effect of an `SseEvent`: any fs event naming an archive's own path
 * (overwritten, moved, renamed, or deleted, or restored back into place)
 * can change what an open `ArchivePreview` for that exact path should
 * show, so its query always gets a refetch alongside whatever
 * `keysToInvalidate` already invalidates. Wiring this into
 * `lib/api/sse.ts`'s own `keysToInvalidate` is a follow-up outside this
 * chunk's scope (see `lib/archive/queries.ts`'s own note on
 * `archiveEntriesKey`).
 */
export function archiveKeysToInvalidate(event: SseEvent): QueryKey[] {
  if (event.type !== "fs") {
    return [];
  }
  return [...event.paths, ...(event.targetPaths ?? [])].map((path) => archiveEntriesKey(path));
}
