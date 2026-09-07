"use client";

import type { CreateApiTokenRequest } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";

/** The signed-in account's API tokens (never their secrets), for the account page's tokens table. */
export function useApiTokens() {
  return useQuery({
    queryKey: queryKeys.account.tokens(),
    queryFn: () => apiClient.listApiTokens(),
  });
}

/** Creates an API token. The response's `token` is the raw secret, shown once by the calling component. */
export function useCreateApiToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (req: CreateApiTokenRequest) => apiClient.createApiToken(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.account.tokens() });
    },
  });
}

/** Revokes an API token by id and refreshes the tokens table. */
export function useRevokeApiToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiClient.revokeApiToken(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.account.tokens() });
    },
  });
}

/** Favorites retain their owning identity, including duplicate virtual paths. */
export function useAccountFavorites(accountId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.account.favorites(accountId ?? ""),
    queryFn: () => apiClient.accountFavorites(),
    enabled: accountId !== undefined,
  });
}
