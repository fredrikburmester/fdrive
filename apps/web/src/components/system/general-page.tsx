"use client";

import type { SystemStorage } from "@fdrive/contracts";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import { useSystemStorage, useUpdateSystemStorage } from "@/lib/api/system-queries";
import { LOCAL_FOLDER_NOTE, storageNameError, storageRenamePatch } from "@/lib/system/storage";
import { PublicUrlCard } from "./public-url-card";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";
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
      contentClassName="gap-4"
    >
      {storage.healthy ? null : (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {storage.detail}
        </p>
      )}
      <Field>
        <FieldLabel htmlFor={field}>Name</FieldLabel>
        <Input
          id={field}
          value={value}
          maxLength={120}
          disabled={update.isPending}
          aria-invalid={error !== null}
          onChange={(event) => setDraft(event.target.value)}
        />
        <FieldDescription>Shown under each username and in Finder.</FieldDescription>
        {error === null ? null : <FieldError>{error}</FieldError>}
      </Field>
      {update.isError ? (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {describeApiError(update.error)}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={update.isPending || patch === null} onClick={save}>
          {update.isPending ? "Saving…" : "Save name"}
        </Button>
      </div>
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
    return <Skeleton className="h-40 w-full" />;
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
