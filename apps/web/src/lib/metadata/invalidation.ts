import type { SseEvent } from "@fdrive/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { queryKeys } from "./deps";

/** A prefix key matching every `tags.files` query. */
const TAG_FILES_PREFIX: QueryKey = ["tags", "files"];

/**
 * Pure extension of `lib/api/sse.ts`'s `keysToInvalidate`, for the metadata
 * side effects of an `SseEvent`: any fs event can change whether a path
 * still exists or where it lives (a `change` may be a delete), so the
 * favorites list, the recents list, and every open tag-files listing need a
 * refetch to drop or relocate the affected rows. Tag membership itself
 * survives renames server-side (the API rewrites `file_tags` by prefix on
 * every move); this only refreshes the *paths* an already-open tag page is
 * showing, so a folder renamed over SMB or by another client shows up under
 * its new name without a manual reload.
 */
export function metadataKeysToInvalidate(event: SseEvent): QueryKey[] {
  if (event.type !== "fs") {
    return [];
  }
  return [queryKeys.favorites.list(), queryKeys.recents.list(), TAG_FILES_PREFIX];
}
