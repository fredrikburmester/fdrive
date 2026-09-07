import type { SseEvent } from "@fdrive/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { queryKeys } from "./deps";

/**
 * Pure extension of `lib/api/sse.ts`'s `keysToInvalidate`, for the trash
 * side effect of an `SseEvent`: any fs event (a delete moves something
 * into the trash, a restore or purge moves or removes something in it,
 * anything else at least might if another tab or client changed it) can
 * change what the Trash page should show, so its list always gets a
 * refetch alongside whatever `keysToInvalidate` already invalidates.
 */
export function trashKeysToInvalidate(event: SseEvent): QueryKey[] {
  if (event.type !== "fs") {
    return [];
  }
  return [queryKeys.trash.list()];
}
