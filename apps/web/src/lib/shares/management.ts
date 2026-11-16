"use client";

import type { CreateShareRequest, UpdateShareRequest } from "@fdrive/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { refreshQuery } from "@/lib/api/refresh-query";

export const managedSharesKey = ["shares", "managed"] as const;

/** The signed-in login's public links; every change refreshes the list before it resolves. */
export function useShareManagement() {
  const queryClient = useQueryClient();
  async function run<T>(request: () => Promise<T>): Promise<T> {
    const result = await request();
    await refreshQuery(queryClient, managedSharesKey);
    return result;
  }
  const query = useQuery({
    queryKey: managedSharesKey,
    queryFn: () => apiClient.listShares(),
  });
  return {
    query,
    create: (input: CreateShareRequest) => run(() => apiClient.createShare(input)),
    update: (id: string, input: UpdateShareRequest) => run(() => apiClient.updateShare(id, input)),
    revoke: (id: string) => run(() => apiClient.deleteShare(id)),
    entries: (paths: readonly string[]) => Promise.all(paths.map((path) => apiClient.stat(path))),
  };
}
