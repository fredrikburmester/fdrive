"use client";

import type { CreateTagRequest, FsEntry, ListResponse, UpdateTagRequest } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import {
  type QueryKey,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { refreshQuery } from "@/lib/api/refresh-query";
import { apiClient, queryKeys } from "./deps";
import { DEFAULT_RESOLVE_CONCURRENCY, type ResolvedEntry } from "./resolve";
import { createStatQueue } from "./stat-queue";
import { applyFavoriteToEntries, applyTagsToEntries } from "./tag-set";

/** A prefix key matching every `fs.list` query, for the broad invalidation a
 * tag rename/recolor/delete needs (its effect can show up in any open
 * folder listing, not just one). */
const FS_LIST_PREFIX: QueryKey = ["fs", "list"];
const FS_STAT_PREFIX: QueryKey = ["fs", "stat"];
/** A prefix key matching every `tags.files` query. */
const TAG_FILES_PREFIX: QueryKey = ["tags", "files"];

/** The caller's tags. */
export function useTags() {
  return useQuery({
    queryKey: queryKeys.tags.list(),
    queryFn: async () => (await apiClient.listTags()).tags,
  });
}

/** Every path of the caller's that has tag `id`. */
export function useTagFiles(id: string | null) {
  return useQuery({
    queryKey: queryKeys.tags.files(id ?? ""),
    queryFn: async () => (await apiClient.tagFiles(id as string)).paths,
    enabled: id !== null,
  });
}

/**
 * Create, rename/recolor, and delete for the caller's tags. A create only
 * ever adds a new, unused id, so it invalidates just the tag list; an
 * update or delete can change what an already-loaded folder listing's tag
 * dots should show (a renamed/recolored tag, or one that no longer
 * exists), so those two also invalidate every open `fs.list` query.
 */
export function useTagMutations() {
  const queryClient = useQueryClient();

  function invalidateTagList() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tags.list() });
  }

  function invalidateEverything() {
    invalidateTagList();
    void refreshQuery(queryClient, FS_LIST_PREFIX);
    void refreshQuery(queryClient, FS_STAT_PREFIX);
  }

  const createTag = useMutation({
    mutationFn: (req: CreateTagRequest) => apiClient.createTag(req),
    onSuccess: invalidateTagList,
    onError: () => {
      toast.error("Could not create the tag.");
    },
  });

  const updateTag = useMutation({
    mutationFn: (vars: { id: string; patch: UpdateTagRequest }) =>
      apiClient.updateTag(vars.id, vars.patch),
    onSuccess: invalidateEverything,
    onError: () => {
      toast.error("Could not update the tag.");
    },
  });

  const deleteTag = useMutation({
    mutationFn: (id: string) => apiClient.deleteTag(id),
    onSuccess: invalidateEverything,
    onError: () => {
      toast.error("Could not delete the tag.");
    },
  });

  return { createTag, updateTag, deleteTag };
}

export interface SetFileTagsItem {
  readonly path: string;
  readonly tagIds: readonly string[];
}

interface CachedMetadataSnapshot {
  readonly key: QueryKey;
  readonly data: unknown;
}

/**
 * Replaces the full tag set on one or more paths at once (a multi-selection
 * applies the same final set to every selected entry), optimistically
 * patching `meta.tagIds` on any already-loaded folder listing that has that
 * path, and rolling the patch back if the request fails. On settle, every
 * affected listing and every `tags.files` query are invalidated, since a
 * tag's file list can gain or lose this path.
 */
export function useSetFileTags() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (items: readonly SetFileTagsItem[]) => {
      await Promise.all(
        items.map((item) => apiClient.setFileTags({ path: item.path, tagIds: [...item.tagIds] })),
      );
    },
    onMutate: async (items: readonly SetFileTagsItem[]) => {
      const parents = new Set(items.map((item) => parentPath(item.path)));
      const paths = new Set(items.map((item) => item.path));
      const keys = [
        ...[...parents].map((parent) => queryKeys.fs.list(parent)),
        ...[...paths].map((path) => queryKeys.fs.stat(path)),
      ];
      await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
      const previous: CachedMetadataSnapshot[] = [];
      // Snapshot each listing once before applying a multi-file optimistic patch.
      for (const key of keys) {
        const data = queryClient.getQueryData(key);
        if (data !== undefined) previous.push({ key, data });
      }
      for (const item of items) {
        queryClient.setQueryData<ListResponse>(queryKeys.fs.list(parentPath(item.path)), (data) =>
          data === undefined
            ? undefined
            : { ...data, entries: applyTagsToEntries(data.entries, item.path, item.tagIds) },
        );
        queryClient.setQueryData<FsEntry>(queryKeys.fs.stat(item.path), (data) =>
          data === undefined ? undefined : applyTagsToEntries([data], item.path, item.tagIds)[0],
        );
      }
      return { previous };
    },
    onError: (_error, _items, context) => {
      for (const snapshot of context?.previous ?? []) {
        queryClient.setQueryData(snapshot.key, snapshot.data);
      }
      toast.error("Could not update tags.");
    },
    onSettled: (_data, _error, items) => {
      const parents = new Set(items.map((item) => parentPath(item.path)));
      for (const parent of parents) {
        void refreshQuery(queryClient, queryKeys.fs.list(parent));
      }
      for (const item of items) void refreshQuery(queryClient, queryKeys.fs.stat(item.path));
      void queryClient.invalidateQueries({ queryKey: TAG_FILES_PREFIX });
    },
  });
}

/** The caller's favorites. */
export function useFavorites() {
  return useQuery({
    queryKey: queryKeys.favorites.list(),
    queryFn: async () => (await apiClient.listFavorites()).items,
  });
}

export interface ToggleFavoriteVariables {
  readonly path: string;
  readonly favorite: boolean;
}

/**
 * Adds or removes `path` from the caller's favorites, optimistically
 * patching `meta.favorite` on any already-loaded folder listing that has
 * that path. On settle, that listing and the favorites list are
 * invalidated.
 */
export function useToggleFavorite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars: ToggleFavoriteVariables) => {
      if (vars.favorite) {
        await apiClient.addFavorite({ path: vars.path });
      } else {
        await apiClient.removeFavorite({ path: vars.path });
      }
    },
    onMutate: async (vars: ToggleFavoriteVariables) => {
      const keys = [queryKeys.fs.list(parentPath(vars.path)), queryKeys.fs.stat(vars.path)];
      const previous: CachedMetadataSnapshot[] = [];
      await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
      for (const key of keys) {
        const data = queryClient.getQueryData(key);
        if (data !== undefined) previous.push({ key, data });
      }
      queryClient.setQueryData<ListResponse>(queryKeys.fs.list(parentPath(vars.path)), (data) =>
        data === undefined
          ? undefined
          : { ...data, entries: applyFavoriteToEntries(data.entries, vars.path, vars.favorite) },
      );
      queryClient.setQueryData<FsEntry>(queryKeys.fs.stat(vars.path), (data) =>
        data === undefined
          ? undefined
          : applyFavoriteToEntries([data], vars.path, vars.favorite)[0],
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      for (const snapshot of context?.previous ?? [])
        queryClient.setQueryData(snapshot.key, snapshot.data);
      toast.error("Could not update favorites.");
    },
    onSettled: (_data, _error, vars) => {
      void refreshQuery(queryClient, queryKeys.fs.list(parentPath(vars.path)));
      void refreshQuery(queryClient, queryKeys.fs.stat(vars.path));
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites.list() });
    },
  });
}

/** The caller's recently opened paths (previews and edits). */
export function useRecents() {
  return useQuery({
    queryKey: queryKeys.recents.list(),
    queryFn: async () => (await apiClient.listRecents()).items,
  });
}

/** Records `path` as opened just now. Fire-and-forget from the preview and
 * editor shells; a failure is silent (recents are a convenience, not a
 * critical path) and simply invalidates nothing. */
export function useTouchRecent(contextPath?: string) {
  const queryClient = useQueryClient();
  // One gesture keeps one request ID, so a retried report is the same open
  // rather than a second one.
  const gesture = useMemo(
    () => ({ path: contextPath, requestId: crypto.randomUUID(), at: new Date().toISOString() }),
    [contextPath],
  );
  return useMutation({
    mutationFn: (path: string) =>
      apiClient.touchRecent({
        path,
        ...(gesture.path === path ? { requestId: gesture.requestId, at: gesture.at } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recents.list() });
    },
  });
}

export interface UseResolvedEntriesResult {
  readonly entries: readonly ResolvedEntry[];
  readonly isLoading: boolean;
}

/** Resolves paths through the shared stat cache, observing mutation/SSE invalidations. */
export function useResolvedEntries(paths: readonly string[]): UseResolvedEntriesResult {
  const [run] = useState(() => createStatQueue(DEFAULT_RESOLVE_CONCURRENCY));
  const queries = useQueries({
    queries: paths.map((path) => ({
      queryKey: queryKeys.fs.stat(path),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        run(() => apiClient.stat(path, signal), signal),
      retry: false,
    })),
  });
  return {
    entries: paths.map((path, index) => ({
      path,
      entry: queries[index]?.isError ? null : (queries[index]?.data ?? null),
    })),
    isLoading: queries.some((query) => query.isLoading),
  };
}

export type { FsEntry, ResolvedEntry };
