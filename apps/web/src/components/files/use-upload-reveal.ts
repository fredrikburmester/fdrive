"use client";

import type { ListResponse } from "@fdrive/contracts";
import { joinPath } from "@fdrive/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { refreshIdentityQuery } from "@/lib/account/invalidation";
import { queryKeys } from "@/lib/api/keys";
import { useUploadStore } from "@/lib/upload/store";
import { TERMINAL_STATUSES, type UploadItem } from "@/lib/upload/types";

/** Reveal uploads started during this folder visit, after the batch and listing settle. */
export function useUploadReveal(
  path: string,
  identityId: string | undefined,
  orderedPaths: readonly string[],
  listing: { data: ListResponse | undefined; isFetching: boolean },
  onReveal: (paths: string[]) => void,
): void {
  const queryClient = useQueryClient();
  const visitRef = useRef<object | null>(null);
  const [pending, setPending] = useState<{
    visit: object;
    paths: Set<string>;
    afterUpdateCount: number;
  } | null>(null);

  useEffect(() => {
    const visit = {};
    visitRef.current = visit;
    setPending(null);
    const tracked = new Map<string, UploadItem>();
    const unsubscribe = useUploadStore.subscribe((current, previous) => {
      if (current.activeIdentityId !== identityId) {
        tracked.clear();
        setPending(null);
        return;
      }
      for (const id of current.state.order) {
        const item = current.state.items[id];
        const previousItem = previous.state.items[id];
        if (
          item &&
          (!previousItem ||
            (item.status === "queued" && TERMINAL_STATUSES.has(previousItem.status))) &&
          item.identityId === identityId &&
          item.targetPath === joinPath(path, item.relativePath)
        ) {
          tracked.set(id, item);
        }
      }
      if (tracked.size === 0) return;
      for (const [id, item] of tracked) {
        // Keep completed entries if Activity's Clear removes them while siblings upload.
        tracked.set(id, current.state.items[id] ?? item);
      }
      const items = [...tracked.values()];
      if (items.some((item) => !TERMINAL_STATUSES.has(item.status))) return;
      tracked.clear();
      const paths = new Set(
        items
          .filter((item) => item.status === "done")
          .map((item) => joinPath(path, item.relativePath.split("/")[0] ?? item.relativePath)),
      );
      if (paths.size === 0) return;
      const queryKey = queryKeys.fs.list(path);
      setPending({
        visit,
        paths,
        afterUpdateCount: queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0,
      });
      // Folder drops create ancestors; the queue refreshes only each file's immediate parent.
      void refreshIdentityQuery(queryClient, queryKey);
    });
    return () => {
      visitRef.current = null;
      unsubscribe();
    };
  }, [path, identityId, queryClient]);

  useEffect(() => {
    if (!pending || pending.visit !== visitRef.current || listing.isFetching) return;
    const query = queryClient.getQueryState<ListResponse>(queryKeys.fs.list(path));
    // Upload callbacks can cancel/restart this refresh. Require a newer successful
    // result, and wait until the browser has rendered that same listing/sort order.
    if (
      !query ||
      query.fetchStatus !== "idle" ||
      query.dataUpdateCount <= pending.afterUpdateCount ||
      query.data !== listing.data
    ) {
      return;
    }
    setPending(null);
    const paths = orderedPaths.filter((candidate) => pending.paths.has(candidate));
    if (paths.length > 0) onReveal(paths);
  }, [pending, orderedPaths, listing.data, listing.isFetching, path, queryClient, onReveal]);
}
