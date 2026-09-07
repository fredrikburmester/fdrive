"use client";

import type { LinkIdentityRequest, MeResponse } from "@fdrive/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";
import { describeApiError } from "@/lib/api/errors";
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
      setError(describeApiError(cause));
      return false;
    }
  }

  return {
    pending,
    error,
    resetError: () => setError(null),
    link: (request: LinkIdentityRequest) => run(() => apiClient.linkIdentity(request)),
    unlink: (id: string) =>
      run(async () => {
        const me = await apiClient.unlinkIdentity(id);
        useUploadStore.getState().cancelIdentity(id);
        return me;
      }),
    switch: async (id: string, href?: string) => {
      const succeeded = await run(() => apiClient.switchIdentity(id), href);
      if (!succeeded) throw new Error("Could not switch login. Please try again.");
    },
  };
}
