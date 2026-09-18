"use client";

import type { CreateShareRequest, UpdateShareRequest } from "@fdrive/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { refreshIdentityQuery } from "@/lib/account/invalidation";
import { accountTransition, useAccountTransition } from "@/lib/account/transition";
import { getTabIdentity, snapshotTabApiClient } from "@/lib/api/client";

export const managedSharesKey = (identity: string | undefined) =>
  ["shares", "managed", identity] as const;

export interface ShareManagementOptions {
  /**
   * Whether to list the login's links at all. The Shares page passes false
   * for a login whose storage cannot share, so the page states the limit
   * instead of asking the API for a refusal it already knows about.
   */
  readonly list?: boolean;
}

export function useShareManagement({ list = true }: ShareManagementOptions = {}) {
  const queryClient = useQueryClient();
  const { pending } = useAccountTransition();
  const [scope] = useState(() => ({
    client: snapshotTabApiClient(),
    identity: getTabIdentity(),
    generation: accountTransition.getSnapshot().generation,
  }));
  function current(): boolean {
    const state = accountTransition.getSnapshot();
    return !state.pending && state.generation === scope.generation;
  }
  async function run<T>(request: () => Promise<T>): Promise<T | null> {
    if (!current()) throw new Error("The active login changed.");
    const result = await request();
    if (!current()) return null;
    await refreshIdentityQuery(queryClient, managedSharesKey(scope.identity));
    return current() ? result : null;
  }
  const query = useQuery({
    queryKey: managedSharesKey(scope.identity),
    queryFn: () => {
      if (!current()) throw new Error("The active login changed.");
      return scope.client.listShares();
    },
    enabled: list && !pending,
  });
  return {
    query,
    create: (input: CreateShareRequest) => run(() => scope.client.createShare(input)),
    update: (id: string, input: UpdateShareRequest) =>
      run(() => scope.client.updateShare(id, input)),
    revoke: (id: string) => run(() => scope.client.deleteShare(id)),
    entries: (paths: readonly string[]) =>
      run(() => Promise.all(paths.map((path) => scope.client.stat(path)))),
  };
}
