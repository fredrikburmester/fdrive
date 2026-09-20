"use client";
import type { ClientActivityRequest } from "@fdrive/contracts";
import { useEffect, useMemo } from "react";
import { getTabIdentity } from "@/lib/api/client";
import { activityRequest } from "./api";

/** Capture before awaiting clipboard/navigation; a later login switch cannot retarget it. */
export function activityGesture(
  action: ClientActivityRequest["action"],
  path: string,
  shareId?: string,
) {
  const identityId = getTabIdentity();
  if (!identityId) return () => Promise.resolve();
  const event: ClientActivityRequest = {
    identityId,
    action,
    path,
    requestId: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...(shareId ? { shareId } : {}),
  };
  return async () => {
    await activityRequest("/client-events", { method: "POST", body: JSON.stringify(event) });
  };
}
export function useActivityGesture(action: ClientActivityRequest["action"], path?: string) {
  const identityId = getTabIdentity();
  const gesture = useMemo(
    () => (identityId && path ? activityGesture(action, path) : null),
    [action, path, identityId],
  );
  useEffect(() => {
    void gesture?.().catch(() => undefined);
  }, [gesture]);
}
