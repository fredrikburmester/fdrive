"use client";

import {
  ApiClientError,
  type OkResponse,
  type TrashListResponse,
  type TrashRestoreResponse,
} from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { refreshQuery } from "@/lib/api/refresh-query";
import { describeFsError } from "@/lib/files/queries";
import { apiClient, queryKeys } from "./deps";

/** The signed-in login's trash listing. */
export function useTrash() {
  return useQuery({
    queryKey: queryKeys.trash.list(),
    queryFn: () => apiClient.trashList(),
  });
}

/**
 * The shared shape behind every trash mutation hook: always refreshes the
 * trash list on success, and shows a toast built from `describeFsError` on
 * failure, unless `suppressErrorToast` says the caller already has a more
 * specific toast planned for this error (used by `useTrashRestore`, whose
 * caller shows a richer, actionable toast for a restore conflict instead of
 * the generic one below).
 */
function useTrashMutation<TVariables, TResult>(config: {
  mutationFn: (vars: TVariables) => Promise<TResult>;
  onSuccess?: (vars: TVariables, result: TResult, queryClient: QueryClient) => void;
  errorFallback: string;
  suppressErrorToast?: (error: unknown) => boolean;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: config.mutationFn,
    onSuccess: (result, vars) => {
      void refreshQuery(queryClient, queryKeys.trash.list());
      config.onSuccess?.(vars, result, queryClient);
    },
    onError: (error) => {
      if (config.suppressErrorToast?.(error) === true) return;
      toast.error(describeFsError(error, config.errorFallback));
    },
  });
}

/** True for a 409 restore conflict: the caller shows its own actionable
 * toast (naming the file, offering "Restore to") for that case instead
 * of `useTrashMutation`'s generic one. */
export function isRestoreConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.kind === "conflict";
}

export interface TrashRestoreVariables {
  readonly ids: readonly string[];
  /** Only meaningful (and only accepted by the API) with exactly one id. */
  readonly target?: string;
}

/**
 * Restores one or more trash entries. On success, besides the trash list,
 * invalidates each restored entry's new parent listing, the same way
 * `useMove` invalidates a move's target.
 */
export function useTrashRestore() {
  return useTrashMutation<TrashRestoreVariables, TrashRestoreResponse>({
    mutationFn: (vars) =>
      apiClient.trashRestore(
        vars.target === undefined
          ? { ids: [...vars.ids] }
          : { ids: [...vars.ids], target: vars.target },
      ),
    onSuccess: (_vars, result, queryClient) => {
      for (const entry of result.restored) {
        void refreshQuery(queryClient, queryKeys.fs.list(parentPath(entry.path)));
      }
    },
    errorFallback: "Could not restore.",
    suppressErrorToast: isRestoreConflict,
  });
}

/** Permanently deletes one or more trash entries. */
export function useTrashPurge() {
  return useTrashMutation<readonly string[], OkResponse>({
    mutationFn: (ids) => apiClient.trashPurge({ ids: [...ids] }),
    errorFallback: "Could not delete permanently.",
  });
}

/** Permanently empties the whole trash. */
export function useTrashEmpty() {
  return useTrashMutation<void, OkResponse>({
    mutationFn: () => apiClient.trashEmpty(),
    errorFallback: "Could not empty the trash.",
  });
}

export type { TrashListResponse };
