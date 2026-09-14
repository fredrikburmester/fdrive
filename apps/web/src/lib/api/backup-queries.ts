"use client";
import { createBackupClient } from "@fdrive/contracts";
import { useQuery } from "@tanstack/react-query";
import { getTabIdentity } from "./client";
export const backupClient = createBackupClient({ identityId: getTabIdentity });
export const backupQueryKey = ["system", "backups"] as const;
export function useBackups() {
  return useQuery({
    queryKey: backupQueryKey,
    queryFn: () => backupClient.status(),
    refetchInterval: 5000,
    retry: false,
  });
}
