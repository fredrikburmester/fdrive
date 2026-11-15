"use client";
import type { ClientActivityRequest } from "@fdrive/contracts";
import { useEffect, useMemo } from "react";
import { activityRequest } from "./api";

/** One receipt per gesture: retries send the same request ID, so history records it once. */
export function activityGesture(
  action: ClientActivityRequest["action"],
  path: string,
  shareId?: string,
) {
  const event: ClientActivityRequest = {
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
  const gesture = useMemo(() => (path ? activityGesture(action, path) : null), [action, path]);
  useEffect(() => {
    void gesture?.().catch(() => undefined);
  }, [gesture]);
}
