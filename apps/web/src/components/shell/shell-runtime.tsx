"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { UploadFilesProvider } from "@/components/upload/upload-provider";
import { apiClient } from "@/lib/api/client";
import { useFsEvents } from "@/lib/api/sse";
import { useJobsStore } from "@/lib/jobs/store";

/**
 * The shell's client-only runtime, mounted once by `(shell)/layout.tsx`:
 * the live-update SSE connection (`useFsEvents`), a one-time load of the
 * caller's jobs into the jobs store (`apiClient.jobs()`, so a page reload
 * still shows jobs already in flight), and the single upload/activity
 * queue UI (`UploadFilesProvider`, which itself mounts `ActivityPanel` and
 * `ConflictDialog`).
 */
export function ShellRuntime({ children }: { children: ReactNode }) {
  useFsEvents();

  useEffect(() => {
    apiClient
      .jobs()
      .then((jobs) => useJobsStore.getState().hydrate(jobs))
      .catch(() => {
        // Best-effort: the Activity panel simply starts empty of past jobs.
      });
  }, []);

  return <UploadFilesProvider>{children}</UploadFilesProvider>;
}
