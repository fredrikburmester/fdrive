"use client";
import { createApiClient } from "@fdrive/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client";

/** Capabilities contain no session tokens. Open descriptors deliberately bypass query caching. */
export function officeStatusQueryOptions() {
  return {
    queryKey: ["office", "status"],
    queryFn: () => apiClient.officeStatus(),
    // Discover newly started editors after onboarding, and reflect live disablement.
    staleTime: 10_000,
    refetchInterval: 10_000,
    retry: false,
  };
}
export function useOfficeStatus() {
  return useQuery(officeStatusQueryOptions());
}

export function officeClientForIdentity(identityId: string) {
  return createApiClient({ baseUrl: "", identityId });
}
