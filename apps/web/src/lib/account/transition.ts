"use client";

import type { MeResponse } from "@fdrive/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { useSyncExternalStore } from "react";
import { pinTabIdentity } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { useJobsStore } from "@/lib/jobs/store";
import { useUploadStore } from "@/lib/upload/store";

export interface AccountTransitionState {
  readonly pending: boolean;
  readonly generation: number;
}

/** Shared gate prevents competing session mutations and masks the old shell. */
export function createAccountTransitionStore() {
  let state: AccountTransitionState = { pending: false, generation: 0 };
  const listeners = new Set<() => void>();
  function publish(next: AccountTransitionState) {
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin() {
      if (state.pending) throw new Error("A login change is already in progress.");
      publish({ ...state, pending: true });
    },
    finish(changed: boolean) {
      publish({ pending: false, generation: state.generation + (changed ? 1 : 0) });
    },
  };
}

export const accountTransition = createAccountTransitionStore();

export function useAccountTransition() {
  return useSyncExternalStore(
    accountTransition.subscribe,
    accountTransition.getSnapshot,
    accountTransition.getSnapshot,
  );
}

/** Cancellation detaches late promises before any new identity can populate the cache. */
export async function transitionAccount(
  queryClient: QueryClient,
  request: () => Promise<MeResponse>,
  navigate: (href: Route) => void,
  target: string = "/files",
  store = accountTransition,
): Promise<MeResponse> {
  store.begin();
  let changed = false;
  try {
    await queryClient.cancelQueries();
    const me = await request();
    changed = true;
    await queryClient.cancelQueries();
    queryClient.clear();
    pinTabIdentity(me.activeIdentityId);
    queryClient.setQueryData(queryKeys.auth.me(), me);
    useJobsStore.getState().reset();
    useUploadStore.getState().setActiveIdentity(me.activeIdentityId);
    navigate(target as Route);
    return me;
  } finally {
    store.finish(changed);
  }
}
