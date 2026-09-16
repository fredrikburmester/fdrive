"use client";

import type { LinkIdentityRequest, MeResponse, UnlinkIdentityRequest } from "@fdrive/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";
import { describeCredentialError } from "@/lib/api/errors";
import { useUploadStore } from "@/lib/upload/store";
import { transitionAccount, useAccountTransition } from "./transition";

/** Credentials stay in the request stack, never in TanStack mutation variables. */
export function useIdentityActions() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { pending } = useAccountTransition();
  const [error, setError] = useState<string | null>(null);

  async function run(request: () => Promise<MeResponse>, target?: string): Promise<boolean> {
    setError(null);
    try {
      await transitionAccount(queryClient, request, router.push, target);
      return true;
    } catch (cause) {
      setError(describeCredentialError(cause));
      return false;
    }
  }

  return {
    pending,
    error,
    resetError: () => setError(null),
    link: (request: LinkIdentityRequest) => run(() => apiClient.linkIdentity(request)),
    unlink: (id: string, request: UnlinkIdentityRequest) =>
      run(async () => {
        const me = await apiClient.unlinkIdentity(id, request);
        useUploadStore.getState().cancelIdentity(id);
        return me;
      }),
    switch: async (id: string, href?: string) => {
      const succeeded = await run(() => apiClient.switchIdentity(id), href);
      if (!succeeded) throw new Error("Could not switch login. Please try again.");
    },
  };
}
