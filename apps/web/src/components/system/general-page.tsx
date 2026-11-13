"use client";

import type { AdminProvider } from "@fdrive/contracts";
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import { useAdminProviders, useAdminUpdateProvider } from "@/lib/api/system-queries";
import {
  LOCAL_FOLDER_NOTE,
  providerNameError,
  STORAGE_MISSING_NOTE,
  STORAGE_UNREACHABLE_NOTE,
  storageRenamePatch,
} from "@/lib/system/storage";
import { PublicUrlCard } from "./public-url-card";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";
import { TrashSettingsCard } from "./trash-settings-card";

/** The files folder's display name, and a warning when fdrive cannot reach it. */
function StorageCard({ provider }: { provider: AdminProvider }) {
  const update = useAdminUpdateProvider();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? provider.label;
  const error = draft === null ? null : providerNameError(draft);
  const patch = storageRenamePatch(provider, value);
  const field = `storage-name-${provider.id}`;

  function save() {
    if (patch === null) return;
    update.mutate({ id: provider.id, patch }, { onSuccess: () => setDraft(null) });
  }

  return (
    <SystemSection
      title="Storage"
      description={LOCAL_FOLDER_NOTE}
      {...(provider.reachable ? {} : { actions: <Badge variant="destructive">Unreachable</Badge> })}
      contentClassName="gap-4"
    >
      {provider.reachable ? null : (
        <p role="alert" className="text-sm text-destructive">
          {STORAGE_UNREACHABLE_NOTE}
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
        <FieldDescription>Shown on the login page and in Finder.</FieldDescription>
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

/** The files folder's settings: its name and reachability, then its Trash. */
function StorageSettings() {
  const query = useAdminProviders();
  if (query.isError) {
    return <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.data === undefined) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (query.data.providers.length === 0) {
    return <SystemSection title="Storage" description={STORAGE_MISSING_NOTE} />;
  }
  return query.data.providers.map((provider) => (
    <Fragment key={provider.id}>
      <StorageCard provider={provider} />
      {provider.capabilities.trash ? (
        <TrashSettingsCard provider={{ id: provider.id, label: provider.label }} />
      ) : null}
    </Fragment>
  ));
}

/**
 * Admin page: `System > General`. The installation-wide settings that are
 * neither a feature nor a sidecar: the address fdrive is reached at, and
 * the files folder (`FDRIVE_STORAGE_ROOT`) with its name and Trash.
 */
export function GeneralPage() {
  const publicUrl = useSystemPublicUrl();
  const providers = useAdminProviders();
  const updatedAt = Math.max(publicUrl.dataUpdatedAt, providers.dataUpdatedAt);

  return (
    <SystemPage
      title="General"
      description="Settings for the whole installation."
      lastUpdated={updatedAt > 0 ? new Date(updatedAt) : null}
    >
      <PublicUrlCard />
      <StorageSettings />
    </SystemPage>
  );
}
