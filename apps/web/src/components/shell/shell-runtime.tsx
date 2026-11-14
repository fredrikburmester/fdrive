"use client";

import { type ReactNode, useEffect, useState } from "react";
import { UploadFilesProvider } from "@/components/upload/upload-provider";
import { apiClient } from "@/lib/api/client";
import { useFsEvents } from "@/lib/api/sse";
import { useJobsStore } from "@/lib/jobs/store";
import { SearchShortcutProvider } from "@/lib/search/shortcut";

function SessionRuntime({ children }: { children: ReactNode }) {
  useFsEvents();
  useEffect(() => {
    const hydrate = useJobsStore.getState().hydrate;
    let cancelled = false;
    apiClient
      .jobs()
      .then((jobs) => {
        if (!cancelled) hydrate(jobs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return <UploadFilesProvider>{children}</UploadFilesProvider>;
}

/** Mounts the shell's live connections once the client has hydrated. */
export function ShellRuntime({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  // Mount the runtime on the client only: rendering Next's routing children
  // during hydration delays their effects and makes initial interaction race it.
  return (
    <SearchShortcutProvider>
      {hydrated ? (
        <SessionRuntime>{children}</SessionRuntime>
      ) : (
        <div
          role="status"
          className="flex min-h-screen w-full items-center justify-center text-sm text-muted-foreground"
        >
          Loading fdrive…
        </div>
      )}
    </SearchShortcutProvider>
  );
}
