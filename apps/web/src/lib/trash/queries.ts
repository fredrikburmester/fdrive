"use client";

import {
  type ApiClient,
  ApiClientError,
  type OkResponse,
  type TrashListResponse,
  type TrashRestoreResponse,
  type TrashStatusResponse,
} from "@fdrive/contracts";
import { parentPath } from "@fdrive/core";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { refreshIdentityQuery } from "@/lib/account/invalidation";
import { accountTransition } from "@/lib/account/transition";
import { describeFsError } from "@/lib/files/queries";
import { apiClient, queryKeys, snapshotTabApiClient } from "./deps";

/** How long a fetched trash status is considered fresh: it only ever
 * changes when an operator reconfigures the storage provider, not while a
 * tab is open. */
const TRASH_STATUS_STALE_TIME_MS = 5 * 60 * 1000;

/** Whether the active identity's storage provider exposes a trash, and its configuration. */
export function useTrashStatus() {
  return useQuery({
    queryKey: queryKeys.trash.status(),
    queryFn: () => apiClient.trashStatus(),
    staleTime: TRASH_STATUS_STALE_TIME_MS,
  });
}

/** The active identity's trash listing. */
export function useTrash() {
  return useQuery({
    queryKey: queryKeys.trash.list(),
    queryFn: () => apiClient.trashList(),
  });
}

/**
 * The shared shape behind every trash mutation hook: pins the API client
 * and login generation at mount (so a mutation started before a login
 * switch never lands against the new identity, matching `lib/files/queries.ts`'s
 * `useFsMutation`), always refreshes the trash list on success, and shows a
 * toast built from `describeFsError` on failure, unless `suppressErrorToast`
 * says the caller already has a more specific toast planned for this error
 * (used by `useTrashRestore`, whose caller shows a richer, actionable toast
 * for a restore conflict instead of the generic one below).
 */
function useTrashMutation<TVariables, TResult>(config: {
  mutationFn: (vars: TVariables, client: ApiClient) => Promise<TResult>;
  onSuccess?: (vars: TVariables, result: TResult, queryClient: QueryClient) => void;
  errorFallback: string;
  suppressErrorToast?: (error: unknown) => boolean;
}) {
  const queryClient = useQueryClient();
  const [scope] = useState(() => ({
    generation: accountTransition.getSnapshot().generation,
    client: snapshotTabApiClient(),
  }));
  return useMutation({
    mutationFn: (vars: TVariables) => {
      const current = accountTransition.getSnapshot();
      if (current.pending || current.generation !== scope.generation) {
        return Promise.reject(new Error("The active login changed."));
      }
      return config.mutationFn(vars, scope.client);
    },
    onSuccess: (result, vars) => {
      if (scope.generation !== accountTransition.getSnapshot().generation) return;
      void refreshIdentityQuery(queryClient, queryKeys.trash.list());
      config.onSuccess?.(vars, result, queryClient);
    },
    onError: (error) => {
      if (scope.generation !== accountTransition.getSnapshot().generation) return;
      if (config.suppressErrorToast?.(error) === true) return;
      toast.error(describeFsError(error, config.errorFallback));
    },
  });
}

/** True for a 409 restore conflict: the caller shows its own actionable
 * toast (naming the file, offering "Restore to...") for that case instead
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
    mutationFn: (vars, client) =>
      client.trashRestore(
        vars.target === undefined
          ? { ids: [...vars.ids] }
          : { ids: [...vars.ids], target: vars.target },
      ),
    onSuccess: (_vars, result, queryClient) => {
      for (const entry of result.restored) {
        void refreshIdentityQuery(queryClient, queryKeys.fs.list(parentPath(entry.path)));
      }
    },
    errorFallback: "Could not restore.",
    suppressErrorToast: isRestoreConflict,
  });
}

/** Permanently deletes one or more trash entries. */
export function useTrashPurge() {
  return useTrashMutation<readonly string[], OkResponse>({
    mutationFn: (ids, client) => client.trashPurge({ ids: [...ids] }),
    errorFallback: "Could not delete permanently.",
  });
}

/** Permanently empties the whole trash. */
export function useTrashEmpty() {
  return useTrashMutation<void, OkResponse>({
    mutationFn: (_vars, client) => client.trashEmpty(),
    errorFallback: "Could not empty the trash.",
  });
}

export type { TrashListResponse, TrashStatusResponse };
