"use client";

import type {
  IdentityScopeResponse,
  MountMappingsResponse,
  SetIdentityScopeRequestInput,
  SetMountMappingsRequest,
} from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

/** One linked login's scope mapping and index-availability status, as the account page shows it. */
export function useIdentityScope(identityId: string) {
  return useQuery({
    queryKey: queryKeys.account.identityScope(identityId),
    queryFn: () => apiClient.identityScope(identityId),
  });
}

/**
 * Replaces the login's stored override. The `PUT` already returns the
 * status that reflects the change, so it is written straight into the
 * cache rather than refetched; search views are invalidated because the
 * verified scope set (and therefore what search may return) just changed.
 */
export function useSetIdentityScope(identityId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetIdentityScopeRequestInput) =>
      apiClient.setIdentityScope(identityId, body),
    onSuccess: async (status: IdentityScopeResponse) => {
      client.setQueryData(queryKeys.account.identityScope(identityId), status);
      await client.invalidateQueries({ queryKey: ["search"] });
    },
  });
}

/** Confirmed candidate locations for a login's unmapped mounts. Administrator-only, so gate with `enabled`. */
export function useIdentityScopeSuggestions(identityId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.account.identityScopeSuggestions(identityId),
    queryFn: () => apiClient.identityScopeSuggestions(identityId),
    enabled,
  });
}

/** The folder-level mappings. Administrator-only, so gate with `enabled`. */
export function useMountMappings(enabled = true) {
  return useQuery({
    queryKey: queryKeys.system.mountMappings(),
    queryFn: () => apiClient.mountMappings(),
    enabled,
  });
}

/**
 * Replaces the folder-level mappings. Every login's status may change
 * (adoption is decided per login), so all cached scope statuses and
 * suggestions are refetched, and search views are invalidated.
 */
export function useSetMountMappings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetMountMappingsRequest) => apiClient.setMountMappings(body),
    onSuccess: async (mappings: MountMappingsResponse) => {
      client.setQueryData(queryKeys.system.mountMappings(), mappings);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["account", "identity-scope"] }),
        client.invalidateQueries({ queryKey: ["account", "identity-scope-suggestions"] }),
        client.invalidateQueries({ queryKey: ["search"] }),
      ]);
    },
  });
}
