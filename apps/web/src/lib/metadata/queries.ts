"use client";

import type { CreateTagRequest, FsEntry, ListResponse, UpdateTagRequest } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiClient, queryKeys } from "./deps";
import { DEFAULT_RESOLVE_CONCURRENCY, type ResolvedEntry, resolveEntries } from "./resolve";
import { applyFavoriteToEntries, applyTagsToEntries } from "./tag-set";

/** A prefix key matching every `fs.list` query, for the broad invalidation a
 * tag rename/recolor/delete needs (its effect can show up in any open
 * folder listing, not just one). */
const FS_LIST_PREFIX: QueryKey = ["fs", "list"];
/** A prefix key matching every `tags.files` query. */
const TAG_FILES_PREFIX: QueryKey = ["tags", "files"];

/** The caller's tags, shared across every identity of the account. */
export function useTags() {
  return useQuery({
    queryKey: queryKeys.tags.list(),
    queryFn: async () => (await apiClient.listTags()).tags,
  });
}

/** Every path (for the caller's active identity) that has tag `id`. */
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
    void queryClient.invalidateQueries({ queryKey: FS_LIST_PREFIX });
  }

  const createTag = useMutation({
    mutationFn: (req: CreateTagRequest) => apiClient.createTag(req),
    onSuccess: () => invalidateTagList(),
    onError: () => toast.error("Could not create the tag."),
  });

  const updateTag = useMutation({
    mutationFn: (vars: { id: string; patch: UpdateTagRequest }) =>
      apiClient.updateTag(vars.id, vars.patch),
    onSuccess: () => invalidateEverything(),
    onError: () => toast.error("Could not update the tag."),
  });

  const deleteTag = useMutation({
    mutationFn: (id: string) => apiClient.deleteTag(id),
    onSuccess: () => invalidateEverything(),
    onError: () => toast.error("Could not delete the tag."),
  });

  return { createTag, updateTag, deleteTag };
}

export interface SetFileTagsItem {
  readonly path: string;
  readonly tagIds: readonly string[];
}

interface CachedListSnapshot {
  readonly key: QueryKey;
  readonly data: ListResponse;
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
      await Promise.all(
        [...parents].map((parent) =>
          queryClient.cancelQueries({ queryKey: queryKeys.fs.list(parent) }),
        ),
      );

      const previous: CachedListSnapshot[] = [];
      for (const item of items) {
        const key = queryKeys.fs.list(parentPath(item.path));
        const data = queryClient.getQueryData<ListResponse>(key);
        if (data !== undefined) {
          previous.push({ key, data });
          queryClient.setQueryData<ListResponse>(key, {
            ...data,
            entries: applyTagsToEntries(data.entries, item.path, item.tagIds),
          });
        }
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
        void queryClient.invalidateQueries({ queryKey: queryKeys.fs.list(parent) });
      }
      void queryClient.invalidateQueries({ queryKey: TAG_FILES_PREFIX });
    },
  });
}

/** The caller's favorites, for the active identity. */
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
      const key = queryKeys.fs.list(parentPath(vars.path));
      await queryClient.cancelQueries({ queryKey: key });
      const data = queryClient.getQueryData<ListResponse>(key);
      if (data !== undefined) {
        queryClient.setQueryData<ListResponse>(key, {
          ...data,
          entries: applyFavoriteToEntries(data.entries, vars.path, vars.favorite),
        });
      }
      return { key, data };
    },
    onError: (_error, _vars, context) => {
      if (context?.data !== undefined) {
        queryClient.setQueryData(context.key, context.data);
      }
      toast.error("Could not update favorites.");
    },
    onSettled: (_data, _error, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fs.list(parentPath(vars.path)) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites.list() });
    },
  });
}

/** The caller's recently opened paths (previews and edits), for the active identity. */
export function useRecents() {
  return useQuery({
    queryKey: queryKeys.recents.list(),
    queryFn: async () => (await apiClient.listRecents()).items,
  });
}

/** Records `path` as opened just now. Fire-and-forget from the preview and
 * editor shells; a failure is silent (recents are a convenience, not a
 * critical path) and simply invalidates nothing. */
export function useTouchRecent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => apiClient.touchRecent({ path }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recents.list() });
    },
  });
}

export interface UseResolvedEntriesResult {
  readonly entries: readonly ResolvedEntry[];
  readonly isLoading: boolean;
}

/**
 * Resolves `paths` to live `FsEntry`s via `apiClient.stat`, for the
 * favorites/recents/tag "virtual listing" pages, which have a list of paths
 * rather than a real folder to list. Re-resolves whenever the path list
 * changes (compared by its joined contents, not array identity, so a
 * caller mapping a query result to a plain array of paths on every render
 * does not retrigger this on every render). Not a `useQuery` because there
 * is no single stable key naming "this exact set of paths" that would be
 * useful to cache or invalidate from elsewhere; each page owns its own
 * resolution instead.
 */
export function useResolvedEntries(paths: readonly string[]): UseResolvedEntriesResult {
  const [entries, setEntries] = useState<readonly ResolvedEntry[]>([]);
  const [isLoading, setIsLoading] = useState(paths.length > 0);
  const key = paths.join(" ");

  // Deliberately keyed on `key` (the joined path list) below, not `paths`
  // itself: see the doc comment above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `paths` joined; re-running per new array identity for the same paths would loop.
  useEffect(() => {
    let cancelled = false;
    if (paths.length === 0) {
      setEntries([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void resolveEntries(paths, (path) => apiClient.stat(path), DEFAULT_RESOLVE_CONCURRENCY).then(
      (resolved) => {
        if (!cancelled) {
          setEntries(resolved);
          setIsLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { entries, isLoading };
}

export type { FsEntry, ResolvedEntry };
