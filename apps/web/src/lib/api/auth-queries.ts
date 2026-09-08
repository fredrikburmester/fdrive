"use client";

import type { LoginRequest, MeResponse } from "@fdrive/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { accountTransition, useAccountTransition } from "@/lib/account/transition";
import { useJobsStore } from "@/lib/jobs/store";
import { useUploadStore } from "@/lib/upload/store";
import { apiClient, pinTabIdentity } from "./client";
import { queryKeys } from "./keys";

/**
 * `/files` is served by an optional catch-all route
 * (`app/(shell)/files/[[...path]]`), which Next's typed routes only model as
 * `/files/${string}`, not the bare path. This is the one, documented escape
 * hatch for that gap.
 */
const FILES_ROUTE = "/files" as unknown as Route;

export interface NavigableRouter {
  push: (href: Route) => void;
}

/** The signed-in account and its identities. Powers the shell and `/login`'s redirect check. */
export function useMe() {
  const { pending } = useAccountTransition();
  return useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: () => apiClient.me(),
    enabled: !pending,
  });
}

/**
 * Seeds the `auth.me` query cache with a fresh `MeResponse` (from a
 * successful login) and navigates to `/files`. Exported separately from
 * `useLogin` so the navigation and cache-write logic can be unit tested
 * without rendering a component.
 */
export function handleLoginSuccess(
  queryClient: QueryClient,
  router: NavigableRouter,
  me: MeResponse,
): void {
  void queryClient.cancelQueries();
  queryClient.clear();
  useJobsStore.getState().reset();
  useUploadStore.getState().reset();
  useUploadStore.getState().setActiveIdentity(me.activeIdentityId);
  pinTabIdentity(me.activeIdentityId);
  queryClient.setQueryData(queryKeys.auth.me(), me);
  accountTransition.finish(true);
  router.push(me.isAdmin ? "/setup" : FILES_ROUTE);
}

/**
 * Clears every cached query (nothing from the previous session should
 * survive) and navigates to `/login`. Exported separately from `useLogout`
 * for the same reason as `handleLoginSuccess`.
 */
export function handleLogoutSuccess(queryClient: QueryClient, router: NavigableRouter): void {
  pinTabIdentity(undefined);
  void queryClient.cancelQueries();
  queryClient.clear();
  useJobsStore.getState().reset();
  useUploadStore.getState().reset();
  accountTransition.finish(true);
  router.push("/login");
}

/**
 * Logs in with a username, password, and optional one-time code. On
 * success, seeds the `auth.me` cache so the shell renders immediately and
 * navigates to `/files`.
 */
export function useLogin() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: (req: LoginRequest) => apiClient.login(req),
    onSuccess: (me: MeResponse) => handleLoginSuccess(queryClient, router, me),
  });
}

/** Ends the session, clears every cached query, and navigates to `/login`. */
export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: () => apiClient.logout(),
    onSuccess: () => handleLogoutSuccess(queryClient, router),
  });
}
