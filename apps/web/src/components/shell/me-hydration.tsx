"use client";

import type { MeResponse } from "@fdrive/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { pinTabIdentity } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { useUploadStore } from "@/lib/upload/store";

export interface MeHydrationProps {
  readonly me: MeResponse;
  readonly children: ReactNode;
}

/**
 * Seeds the `auth.me` query cache with the `MeResponse` the shell layout's
 * server component already fetched (to decide whether to redirect to
 * `/login`), so `useMe()` (used by `AppSidebar` and elsewhere) renders
 * immediately from that value instead of firing a second, redundant fetch
 * on mount.
 */
export function MeHydration({ me, children }: MeHydrationProps) {
  const queryClient = useQueryClient();
  // Runs once, synchronously, before this component's first render of
  // `children`: a lazy `useState` initializer, not an effect, so there is
  // no flash of an empty cache.
  useState(() => {
    pinTabIdentity(me.activeIdentityId);
    if (typeof window !== "undefined") {
      useUploadStore.getState().setActiveIdentity(me.activeIdentityId);
    }
    queryClient.setQueryData(queryKeys.auth.me(), me);
  });
  return <>{children}</>;
}
