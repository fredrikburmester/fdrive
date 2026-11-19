"use client";

import type {
  EncryptedFolderInfo,
  EncryptionPasswordRequest,
  EncryptionResetRequest,
  EncryptionSetupRequest,
  EncryptionStatus,
} from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { keyStore } from "./keys";

/**
 * The signed-in person's encryption status. Each answer is handed to the key
 * store, which then knows whether this browser is locked or unlocked.
 */
export function useEncryptionStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.encryption.status(),
    enabled,
    queryFn: async (): Promise<EncryptionStatus> => {
      const status = await apiClient.encryptionStatus();
      await keyStore.refresh(status);
      return status;
    },
    staleTime: 60_000,
  });
}

function useStatusMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.encryption.status() }),
  });
}

/** Turns encryption on with keys the browser made; the caller unlocks with the new identity. */
export function useEnableEncryption() {
  return useStatusMutation((req: EncryptionSetupRequest) => apiClient.enableEncryption(req));
}

export function useChangeEncryptionPassword() {
  return useStatusMutation((req: EncryptionPasswordRequest) =>
    apiClient.changeEncryptionPassword(req),
  );
}

/** Deletes every key copy; encrypted folders stay on disk, unreadable. */
export function useResetEncryption() {
  return useStatusMutation(async (req: EncryptionResetRequest) => {
    await apiClient.resetEncryption(req);
    await keyStore.lock();
  });
}

export function useRemoveEncryptionDevice() {
  return useStatusMutation((id: string) => apiClient.removeEncryptionDevice(id));
}

/** The encrypted folder `path` is or is inside; null when none. */
export function useEncryptedFolder(path: string | null) {
  return useQuery({
    queryKey: queryKeys.encryption.folder(path ?? ""),
    enabled: path !== null,
    queryFn: async (): Promise<EncryptedFolderInfo | null> =>
      (await apiClient.encryptedFolder(path ?? "/")).folder,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
