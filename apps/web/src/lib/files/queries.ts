import {
  ApiClientError,
  type DeleteRequest,
  type FsEntry,
  type ListResponse,
} from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiClient, queryKeys } from "./deps";
import { shouldShowSkeleton } from "./tree";
import { reachableExpandedDirs } from "./tree-rows";

export type ListQueryKey = readonly ["fs", "list", string];

export type FsMutationOp = "mkdir" | "rename" | "move" | "copy" | "delete" | "duplicate";

export interface AffectedListKeysInput {
  /** The mutation kind, which decides how `paths` and `targets` are used. */
  readonly op: FsMutationOp;
  /** The entries the mutation acted on (its own path for mkdir, the
   * deleted/renamed/moved entry's original path otherwise). */
  readonly paths: readonly string[];
  /** The resulting path(s), when the mutation produces new ones (rename,
   * move, copy). Absent for mkdir and delete. */
  readonly targets?: readonly string[];
}

/**
 * Computes which `fs.list` query keys need invalidating after a mutation,
 * purely from its shape:
 *
 * - `mkdir` and `delete` only ever touch `paths`' parent directories.
 * - `copy` leaves the source untouched, so only `targets`' parents change.
 * - `rename` and `move` touch both the source's and the target's parent
 *   (usually the same directory for a rename).
 */
export function affectedListKeys(input: AffectedListKeysInput): ListQueryKey[] {
  const dirs = new Set<string>();
  const targets = input.targets ?? [];

  switch (input.op) {
    case "mkdir":
    case "delete":
    case "duplicate":
      for (const path of input.paths) {
        dirs.add(parentPath(path));
      }
      break;
    case "copy":
      for (const target of targets) {
        dirs.add(parentPath(target));
      }
      break;
    case "rename":
    case "move":
      for (const path of input.paths) {
        dirs.add(parentPath(path));
      }
      for (const target of targets) {
        dirs.add(parentPath(target));
      }
      break;
  }

  return Array.from(dirs, (dir) => queryKeys.fs.list(dir));
}

/** The message shown in a toast for a failed fs mutation. */
export function describeFsError(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    return error.message;
  }
  return fallback;
}

export interface UseListingOptions {
  /** Skips fetching (and marks the query idle) while `false`, for the tree
   * views' lazily-expanded folders. Fetches normally when omitted. */
  readonly enabled?: boolean;
}

/** Lists the entries at `path`, keyed so mutations can invalidate it. */
export function useListing(path: string, options?: UseListingOptions) {
  return useQuery({
    queryKey: queryKeys.fs.list(path),
    queryFn: () => apiClient.list(path),
    ...(options?.enabled === undefined ? {} : { enabled: options.enabled }),
  });
}

export interface ListingSnapshot {
  /** The listing, once it has resolved; `undefined` while in flight or unfetched. */
  readonly data: ListResponse | undefined;
  readonly isLoading: boolean;
}

/**
 * Fetches the listing for every path in `paths` in the background, sharing
 * the same `fs.list` query keys (and therefore the same cache and
 * `staleTime`) as `useListing` and the file browser itself: a path already
 * cached from any of those is never refetched, and a path fetched here is
 * instant if the user later navigates into it or expands it.
 *
 * Used by the sidebar's folder tree to prefetch one level ahead: for every
 * currently visible folder, its own listing is fetched here before the user
 * clicks it, so the tree already knows whether it has subfolders (see
 * `chevronStateFor` in `./tree`). The caller decides what is visible;
 * this never recurses into anything not present in `paths`, so it never
 * fetches into a collapsed folder's descendants.
 */
export function useListings(paths: readonly string[]): ReadonlyMap<string, ListingSnapshot> {
  const results = useQueries({
    queries: paths.map((path) => ({
      queryKey: queryKeys.fs.list(path),
      queryFn: () => apiClient.list(path),
    })),
  });

  return useMemo(() => {
    const map = new Map<string, ListingSnapshot>();
    paths.forEach((path, index) => {
      const result = results[index];
      if (result !== undefined) {
        map.set(path, { data: result.data, isLoading: result.isLoading });
      }
    });
    return map;
  }, [paths, results]);
}

/**
 * `true` only once `active` has been continuously true for at least
 * `delayMs` milliseconds; resets to `false` the instant `active` goes
 * false. Backs the tree's loading skeleton (see `shouldShowSkeleton` in
 * `./tree`), so a folder listing that resolves quickly (the common case,
 * since `useListings` prefetches ahead of the click) never flashes one.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      setVisible(shouldShowSkeleton(startedAt, Date.now(), delayMs));
    }, delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return visible;
}

function useInvalidateAffected() {
  const queryClient = useQueryClient();
  return (input: AffectedListKeysInput) => {
    for (const key of affectedListKeys(input)) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

function useFsMutation<TVariables, TResult>(config: {
  mutationFn: (vars: TVariables) => Promise<TResult>;
  toAffected: (vars: TVariables, result: TResult) => AffectedListKeysInput;
  errorFallback: string;
}) {
  const invalidate = useInvalidateAffected();
  return useMutation({
    mutationFn: config.mutationFn,
    onSuccess: (result, vars) => invalidate(config.toAffected(vars, result)),
    onError: (error) => {
      toast.error(describeFsError(error, config.errorFallback));
    },
  });
}

/** Creates a directory at `path`, invalidating its parent's listing. */
export function useMkdir() {
  return useFsMutation<string, FsEntry>({
    mutationFn: (path) => apiClient.mkdir(path),
    toAffected: (path) => ({ op: "mkdir", paths: [path] }),
    errorFallback: "Could not create the folder.",
  });
}

/** Copies `path` next to itself under a unique name, invalidating its parent's listing. */
export function useDuplicate() {
  return useFsMutation<string, FsEntry>({
    mutationFn: (path) => apiClient.duplicate(path),
    toAffected: (_path, result) => ({ op: "duplicate", paths: [result.path] }),
    errorFallback: "Could not duplicate.",
  });
}

export interface RenameVariables {
  readonly path: string;
  readonly newName: string;
}

/** Renames `path` to `newName` in place, invalidating its parent's listing. */
export function useRename() {
  return useFsMutation<RenameVariables, FsEntry>({
    mutationFn: (vars) => apiClient.rename(vars.path, vars.newName),
    toAffected: (vars, result) => ({ op: "rename", paths: [vars.path], targets: [result.path] }),
    errorFallback: "Could not rename.",
  });
}

export interface MoveVariables {
  readonly path: string;
  readonly target: string;
}

/** Moves `path` to `target`, invalidating both parents' listings. */
export function useMove() {
  return useFsMutation<MoveVariables, FsEntry>({
    mutationFn: (vars) => apiClient.move(vars.path, vars.target),
    toAffected: (vars) => ({ op: "move", paths: [vars.path], targets: [vars.target] }),
    errorFallback: "Could not move.",
  });
}

export interface CopyVariables {
  readonly path: string;
  readonly target: string;
}

/** Copies `path` to `target`, invalidating only the target's listing. */
export function useCopy() {
  return useFsMutation<CopyVariables, FsEntry>({
    mutationFn: (vars) => apiClient.copy(vars.path, vars.target),
    toAffected: (vars) => ({ op: "copy", paths: [vars.path], targets: [vars.target] }),
    errorFallback: "Could not copy.",
  });
}

/**
 * Fetches (and shares the cache and invalidation of) the listing for every
 * directory that is expanded and reachable from `rootEntries`, for the tree
 * view. Returns a map from folder path to its entries, filled in
 * incrementally: each render that discovers newly-expanded folders one
 * level deeper triggers the fetches for that level, converging once every
 * expanded folder's ancestors are loaded.
 */
export function useTreeChildren(
  rootEntries: readonly FsEntry[],
  expanded: ReadonlySet<string>,
): ReadonlyMap<string, readonly FsEntry[]> {
  const [childrenByPath, setChildrenByPath] = useState<Map<string, readonly FsEntry[]>>(
    () => new Map(),
  );

  const expandedDirs = useMemo(
    () => reachableExpandedDirs(rootEntries, expanded, childrenByPath),
    [rootEntries, expanded, childrenByPath],
  );

  const results = useQueries({
    queries: expandedDirs.map((path) => ({
      queryKey: queryKeys.fs.list(path),
      queryFn: () => apiClient.list(path),
    })),
  });

  useEffect(() => {
    setChildrenByPath((prev) => {
      let changed = false;
      const next = new Map(prev);
      expandedDirs.forEach((path, index) => {
        const entries = results[index]?.data?.entries;
        if (entries !== undefined && next.get(path) !== entries) {
          next.set(path, entries);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [expandedDirs, results]);

  return childrenByPath;
}

/** Deletes `items`, invalidating each deleted entry's parent listing. */
export function useDelete() {
  return useFsMutation<DeleteRequest["items"], void>({
    mutationFn: async (items) => {
      await apiClient.remove(items);
    },
    toAffected: (items) => ({ op: "delete", paths: items.map((item) => item.path) }),
    errorFallback: "Could not delete.",
  });
}
