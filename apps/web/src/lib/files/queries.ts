import { ApiClientError, type DeleteRequest, type FsEntry } from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient, queryKeys } from "./deps";

export type ListQueryKey = readonly ["fs", "list", string];

export type FsMutationOp = "mkdir" | "rename" | "move" | "copy" | "delete";

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

/** Lists the entries at `path`, keyed so mutations can invalidate it. */
export function useListing(path: string) {
  return useQuery({
    queryKey: queryKeys.fs.list(path),
    queryFn: () => apiClient.list(path),
  });
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
