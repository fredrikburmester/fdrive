"use client";

import type { AdminConnectionUpdateRequest, SetupCompleteRequest } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

/** Whether setup is required and whether `SFTPGO_URL` is set by environment. Powers `/setup`. */
export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.setup.status(),
    queryFn: () => apiClient.setupStatus(),
  });
}

/** Probes a candidate SFTPGo base URL during setup, using the one-time setup token. */
export function useSetupTest() {
  return useMutation({
    mutationFn: ({ token, baseUrl }: { token: string; baseUrl: string }) =>
      apiClient.setupTest(token, baseUrl),
  });
}

/**
 * Completes setup: stores the connection, logs the admin account in, and
 * seeds the `auth.me` cache with the result so the redirect to `/files`
 * lands in an already-authenticated shell.
 */
export function useSetupComplete() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ token, request }: { token: string; request: SetupCompleteRequest }) =>
      apiClient.setupComplete(token, request),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.auth.me(), me);
    },
  });
}

/** The active SFTPGo connection, for the admin System > Connection page. */
export function useAdminConnection() {
  return useQuery({
    queryKey: queryKeys.admin.connection(),
    queryFn: () => apiClient.adminConnection(),
  });
}

/** Updates the connection (base URL and/or home template) and refreshes the cached summary. */
export function useAdminUpdateConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: AdminConnectionUpdateRequest) => apiClient.adminUpdateConnection(patch),
    onSuccess: (connection) => {
      queryClient.setQueryData(queryKeys.admin.connection(), connection);
    },
  });
}

/** Probes the active connection, or a candidate `baseUrl` when given, without saving anything. */
export function useAdminTestConnection() {
  return useMutation({
    mutationFn: (baseUrl?: string) => apiClient.adminTestConnection(baseUrl),
  });
}
