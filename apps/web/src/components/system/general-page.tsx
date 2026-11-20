"use client";

import type { SystemStorage } from "@fdrive/contracts";
import { useState } from "react";
import { SettingRow } from "@/components/shell/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import { useSystemStorage, useUpdateSystemStorage } from "@/lib/api/system-queries";
import { LOCAL_FOLDER_NOTE, storageNameError, storageRenamePatch } from "@/lib/system/storage";
import { PublicUrlCard } from "./public-url-card";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemAlert, SystemSection } from "./system-section";
import { TrashSettingsCard } from "./trash-settings-card";

/** The files folder's name, and why fdrive cannot use it when it cannot. */
function StorageCard({ storage }: { storage: SystemStorage }) {
  const update = useUpdateSystemStorage();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? storage.name;
  const error = draft === null ? null : storageNameError(draft);
  const patch = storageRenamePatch(storage, value);
  const field = "storage-name";

  function save() {
    if (patch === null) return;
    update.mutate(patch, { onSuccess: () => setDraft(null) });
  }

  return (
    <SystemSection
      title="Storage"
      description={LOCAL_FOLDER_NOTE}
      {...(storage.healthy ? {} : { actions: <Badge variant="destructive">Unavailable</Badge> })}
    >
      {storage.healthy ? null : <SystemAlert row>{storage.detail}</SystemAlert>}
      <SettingRow
        label="Name"
        htmlFor={field}
        description="Shown under each username and in Finder."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={field}
            className="min-w-0 max-w-sm flex-1 basis-56 max-md:min-h-11"
            value={value}
            maxLength={120}
            disabled={update.isPending}
            aria-invalid={error !== null}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            className="max-md:min-h-11"
            disabled={update.isPending || patch === null}
            onClick={save}
          >
            {update.isPending ? "Saving…" : "Save name"}
          </Button>
        </div>
        {error === null ? null : <FieldError className="mt-1.5">{error}</FieldError>}
        {update.isError ? (
          <SystemAlert className="mt-1.5">{describeApiError(update.error)}</SystemAlert>
        ) : null}
      </SettingRow>
    </SystemSection>
  );
}

/** The files folder's settings: its name and health. */
function StorageSettings() {
  const query = useSystemStorage();
  if (query.isError) {
    return <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.data === undefined) {
    return (
      <div className="border-border border-b px-3 py-2.5">
        <Skeleton className="h-8 w-full max-w-md" />
      </div>
    );
  }
  return <StorageCard storage={query.data} />;
}

/**
 * Admin page: `System > General`. The installation-wide settings that are
 * neither a feature nor a sidecar: the address fdrive is reached at, the
 * files folder (`FDRIVE_STORAGE_ROOT`) with its name, and how long Trash
 * keeps an item.
 */
export function GeneralPage() {
  const publicUrl = useSystemPublicUrl();
  const storage = useSystemStorage();
  const updatedAt = Math.max(publicUrl.dataUpdatedAt, storage.dataUpdatedAt);

  return (
    <SystemPage
      title="General"
      description="Settings for the whole installation."
      lastUpdated={updatedAt > 0 ? new Date(updatedAt) : null}
    >
      <PublicUrlCard />
      <StorageSettings />
      <TrashSettingsCard />
    </SystemPage>
  );
}
