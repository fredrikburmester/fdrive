"use client";

import type { CreateGrantRequest, GrantAccess, ReceivedGrant } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { SHARED_WITH_ME_PATH } from "./paths";

/** Grants change only when someone shares or stops sharing, so a minute of staleness is fine. */
const GRANTS_STALE_TIME_MS = 60 * 1000;

const NO_RECEIVED: readonly ReceivedGrant[] = [];

/**
 * The active login's shared folders: what it shares with others (`owned`)
 * and what others share with it (`received`). Pass `enabled: false` for a
 * login whose storage cannot share folders, so nothing is asked.
 */
export function useGrants(enabled = true) {
  return useQuery({
    queryKey: queryKeys.grants.list(),
    queryFn: () => apiClient.grants(),
    staleTime: GRANTS_STALE_TIME_MS,
    enabled,
  });
}

/** The folders shared with the active login, or none while unknown or unavailable. */
export function useReceivedGrants(enabled = true): readonly ReceivedGrant[] {
  return useGrants(enabled).data?.received ?? NO_RECEIVED;
}

/** The other active users a folder can be shared with. */
export function useGrantPeople(enabled = true) {
  return useQuery({
    queryKey: queryKeys.grants.people(),
    queryFn: () => apiClient.grantPeople(),
    staleTime: GRANTS_STALE_TIME_MS,
    enabled,
  });
}

function useGrantMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  ...extraKeys: readonly (readonly unknown[])[]
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.grants.list() });
      for (const key of extraKeys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** Shares a folder with someone, or changes their access when they already have it. */
export const useCreateGrant = () =>
  useGrantMutation((input: CreateGrantRequest) => apiClient.createGrant(input));

/** Changes what someone may do in a folder the active login shares. */
export const useUpdateGrant = () =>
  useGrantMutation(({ id, access }: { id: string; access: GrantAccess }) =>
    apiClient.updateGrant(id, { access }),
  );

/** Stops sharing a folder with someone. */
export const useDeleteGrant = () => useGrantMutation((id: string) => apiClient.deleteGrant(id));

/**
 * Leaves a folder someone shares with the active login. It disappears from
 * `Shared with me`, which itself disappears from the root once empty, so
 * both listings refresh.
 */
export const useLeaveGrant = () =>
  useGrantMutation(
    (id: string) => apiClient.deleteGrant(id),
    queryKeys.fs.list(SHARED_WITH_ME_PATH),
    queryKeys.fs.list("/"),
  );
