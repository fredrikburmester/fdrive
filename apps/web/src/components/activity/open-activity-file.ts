"use client";

import type { PersonalActivityEvent } from "@fdrive/contracts";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { activityFile } from "@/lib/activity/api";
import { useMe } from "@/lib/api/auth-queries";
import { pathToHref, viewHref } from "@/lib/files/path-url";
import { revealHref } from "@/lib/search/reveal";

/**
 * The ways from an event to its file: open it, or show it in its folder. History records where
 * a file was, so both first ask where it is now. `canOpen` is false for an event about no file,
 * for one another login recorded, and while a request is under way.
 */
export function useOpenActivityFile(event: PersonalActivityEvent) {
  const { data: me } = useMe();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function open(kind: "file" | "reveal") {
    if (!event.fileId) return;
    setBusy(true);
    try {
      const current = await activityFile(event.fileId);
      const path = current.currentPath;
      if (!path) throw new Error("This file is unavailable. Its recorded journey is still here.");
      router.push(
        (kind === "reveal"
          ? revealHref(path)
          : current.kind === "dir"
            ? pathToHref(path)
            : viewHref(path)) as Route,
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not open this file");
    } finally {
      setBusy(false);
    }
  }

  // History outlives the login that recorded it; only the signed-in login's files can open.
  const available = event.identityId === me?.identity.id;
  return { open, canOpen: event.fileId !== null && available && !busy };
}
