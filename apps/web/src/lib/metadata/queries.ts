"use client";

import type { CreateTagRequest, FsEntry, ListResponse, UpdateTagRequest } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { refreshIdentityQuery } from "@/lib/account/invalidation";
import { accountTransition } from "@/lib/account/transition";
import { apiClient, queryKeys, snapshotTabApiClient } from "./deps";
import { DEFAULT_RESOLVE_CONCURRENCY, type ResolvedEntry, resolveEntries } from "./resolve";
import { applyFavoriteToEntries, applyTagsToEntries } from "./tag-set";

/** A prefix key matching every `fs.list` query, for the broad invalidation a
 * tag rename/recolor/delete needs (its effect can show up in any open
 * folder listing, not just one). */
const FS_LIST_PREFIX: QueryKey = ["fs", "list"];
const FS_STAT_PREFIX: QueryKey = ["fs", "stat"];
/** A prefix key matching every `tags.files` query. */
const TAG_FILES_PREFIX: QueryKey = ["tags", "files"];

function currentGeneration(): number {
  return accountTransition.getSnapshot().generation;
}
function currentWork(generation: number): boolean {
  return generation === currentGeneration() && !accountTransition.getSnapshot().pending;
}

/** Immutable for the mounted browser, including before asynchronous mutation callbacks. */
function useMetadataScope() {
  const [scope] = useState(() => ({
    generation: currentGeneration(),
    client: snapshotTabApiClient(),
  }));
  return scope;
}

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
  const scope = useMetadataScope();

  function invalidateTagList() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tags.list() });
  }

  function invalidateEverything() {
    invalidateTagList();
    void refreshIdentityQuery(queryClient, FS_LIST_PREFIX);
    void refreshIdentityQuery(queryClient, FS_STAT_PREFIX);
  }

  const createTag = useMutation({
    mutationFn: async (req: CreateTagRequest) => {
      if (!currentWork(scope.generation)) throw new Error("Login changed.");
      return scope.client.createTag(req);
    },
    onSuccess: () => {
      if (scope.generation === currentGeneration()) invalidateTagList();
    },
    onError: () => {
      if (scope.generation === currentGeneration()) toast.error("Could not create the tag.");
    },
  });

  const updateTag = useMutation({
    mutationFn: async (vars: { id: string; patch: UpdateTagRequest }) => {
      if (!currentWork(scope.generation)) throw new Error("Login changed.");
      return scope.client.updateTag(vars.id, vars.patch);
    },
    onSuccess: () => {
      if (scope.generation === currentGeneration()) invalidateEverything();
    },
    onError: () => {
      if (scope.generation === currentGeneration()) toast.error("Could not update the tag.");
    },
  });

  const deleteTag = useMutation({
    mutationFn: async (id: string) => {
      if (!currentWork(scope.generation)) throw new Error("Login changed.");
      return scope.client.deleteTag(id);
    },
    onSuccess: () => {
      if (scope.generation === currentGeneration()) invalidateEverything();
    },
    onError: () => {
      if (scope.generation === currentGeneration()) toast.error("Could not delete the tag.");
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
  const scope = useMetadataScope();

  return useMutation({
    mutationFn: async (items: readonly SetFileTagsItem[]) => {
      if (!currentWork(scope.generation)) throw new Error("Login changed.");
      await Promise.all(
        items.map((item) =>
          scope.client.setFileTags({ path: item.path, tagIds: [...item.tagIds] }),
        ),
      );
    },
    onMutate: async (items: readonly SetFileTagsItem[]) => {
      const { generation } = scope;
      if (!currentWork(generation)) return { previous: [], generation };
      const parents = new Set(items.map((item) => parentPath(item.path)));
      const paths = new Set(items.map((item) => item.path));
      const keys = [
        ...[...parents].map((parent) => queryKeys.fs.list(parent)),
        ...[...paths].map((path) => queryKeys.fs.stat(path)),
      ];
      await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
      const previous: CachedMetadataSnapshot[] = [];
      if (!currentWork(generation)) return { previous, generation };
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
      return { previous, generation };
    },
    onError: (_error, _items, context) => {
      if (context?.generation !== currentGeneration()) return;
      for (const snapshot of context?.previous ?? []) {
        queryClient.setQueryData(snapshot.key, snapshot.data);
      }
      toast.error("Could not update tags.");
    },
    onSettled: (_data, _error, items, context) => {
      if (context?.generation !== currentGeneration()) return;
      const parents = new Set(items.map((item) => parentPath(item.path)));
      for (const parent of parents) {
        void refreshIdentityQuery(queryClient, queryKeys.fs.list(parent));
      }
      for (const item of items)
        void refreshIdentityQuery(queryClient, queryKeys.fs.stat(item.path));
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
  const scope = useMetadataScope();

  return useMutation({
    mutationFn: async (vars: ToggleFavoriteVariables) => {
      if (!currentWork(scope.generation)) throw new Error("Login changed.");
      if (vars.favorite) {
        await scope.client.addFavorite({ path: vars.path });
      } else {
        await scope.client.removeFavorite({ path: vars.path });
      }
    },
    onMutate: async (vars: ToggleFavoriteVariables) => {
      const { generation } = scope;
      const keys = [queryKeys.fs.list(parentPath(vars.path)), queryKeys.fs.stat(vars.path)];
      const previous: CachedMetadataSnapshot[] = [];
      if (!currentWork(generation)) return { previous, generation };
      await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
      if (!currentWork(generation)) return { previous, generation };
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
      return { previous, generation };
    },
    onError: (_error, _vars, context) => {
      if (context?.generation !== currentGeneration()) return;
      for (const snapshot of context.previous)
        queryClient.setQueryData(snapshot.key, snapshot.data);
      toast.error("Could not update favorites.");
    },
    onSettled: (_data, _error, vars, context) => {
      if (context?.generation !== currentGeneration()) return;
      void refreshIdentityQuery(queryClient, queryKeys.fs.list(parentPath(vars.path)));
      void refreshIdentityQuery(queryClient, queryKeys.fs.stat(vars.path));
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites.list() });
      void queryClient.invalidateQueries({ queryKey: ["account"] });
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
  const scope = useMetadataScope();
  return useMutation({
    mutationFn: (path: string) => {
      if (accountTransition.getSnapshot().pending || scope.generation !== currentGeneration()) {
        return Promise.reject(new Error("The active login changed."));
      }
      return scope.client.touchRecent({ path });
    },
    onSuccess: () => {
      if (scope.generation !== currentGeneration()) return;
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
  const key = paths.join("\0");

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
    const client = snapshotTabApiClient();
    const generation = currentGeneration();
    void resolveEntries(paths, (path) => client.stat(path), DEFAULT_RESOLVE_CONCURRENCY).then(
      (resolved) => {
        if (!cancelled && currentWork(generation)) {
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
