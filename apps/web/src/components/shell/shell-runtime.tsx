"use client";

import { Activity, type ReactNode, useEffect, useState } from "react";
import { UploadFilesProvider } from "@/components/upload/upload-provider";
import { useAccountTransition } from "@/lib/account/transition";
import { useMe } from "@/lib/api/auth-queries";
import { apiClient } from "@/lib/api/client";
import { useFsEvents } from "@/lib/api/sse";
import { useJobsStore } from "@/lib/jobs/store";
import { SearchShortcutProvider } from "@/lib/search/shortcut";
import { useUploadStore } from "@/lib/upload/store";

function IdentityRuntime({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  useFsEvents();
  useEffect(() => {
    useUploadStore.getState().setActiveIdentity(me?.activeIdentityId);
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
  }, [me?.activeIdentityId]);
  return <UploadFilesProvider>{children}</UploadFilesProvider>;
}

/** Hide portals and pause effects while preserving form errors on failed changes. */
export function ShellRuntime({ children }: { children: ReactNode }) {
  const { pending, generation } = useAccountTransition();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  // Mount Activity once on the client. A dehydrated Activity around Next's
  // routing children delays their effects and makes initial interaction race hydration.
  return (
    <>
      {pending ? (
        <div
          role="status"
          className="flex min-h-screen w-full items-center justify-center text-sm text-muted-foreground"
        >
          Updating logins…
        </div>
      ) : !hydrated ? (
        <div
          role="status"
          className="flex min-h-screen w-full items-center justify-center text-sm text-muted-foreground"
        >
          Loading fdrive…
        </div>
      ) : null}
      <SearchShortcutProvider key={generation}>
        {hydrated ? (
          <Activity mode={pending ? "hidden" : "visible"}>
            <IdentityRuntime>{children}</IdentityRuntime>
          </Activity>
        ) : null}
      </SearchShortcutProvider>
    </>
  );
}
