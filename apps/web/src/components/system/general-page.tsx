"use client";

import type { SystemStorage } from "@fdrive/contracts";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SettingRow } from "@/components/shell/page-layout";
import { StatusBadge } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import {
  useSystemFeatures,
  useSystemStorage,
  useUpdateFeatures,
  useUpdateSystemStorage,
} from "@/lib/api/system-queries";
import { LOCAL_FOLDER_NOTE, storageNameError, storageRenamePatch } from "@/lib/system/storage";
import { PublicUrlCard } from "./public-url-card";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemAlert } from "./system-section";
import { TrashSettingsCard } from "./trash-settings-card";

/** A problem that belongs to the row above it: under that row, ahead of the next hairline. */
const ROW_PROBLEM = "-mt-2 pb-4.5";

/** The files folder's rows: its name, and whether fdrive can use it and why not. */
function StorageRows({ storage }: { storage: SystemStorage }) {
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
    <>
      <SettingRow
        label="Storage name"
        htmlFor={field}
        description="Shown under each username and in Finder."
      >
        <div className="flex items-center gap-2">
          <Input
            id={field}
            className="min-w-0 flex-1 max-md:min-h-11"
            value={value}
            maxLength={120}
            disabled={update.isPending}
            aria-invalid={error !== null}
            onChange={(event) => setDraft(event.target.value)}
          />
          {/* One of several Saves on the sheet, so it says which one to assistive technology. */}
          <Button
            variant="outline"
            className="max-md:min-h-11"
            aria-label={update.isPending ? undefined : "Save name"}
            disabled={update.isPending || patch === null}
            onClick={save}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        {error === null ? null : <FieldError className="mt-1.5">{error}</FieldError>}
        {update.isError ? (
          <SystemAlert className="mt-1.5">{describeApiError(update.error)}</SystemAlert>
        ) : null}
      </SettingRow>
      <SettingRow label="Files folder" description={LOCAL_FOLDER_NOTE} align="end">
        <StatusBadge tone={storage.healthy ? "success" : "danger"}>
          {storage.healthy ? "Healthy" : "Unavailable"}
        </StatusBadge>
      </SettingRow>
      {storage.healthy ? null : <SystemAlert className={ROW_PROBLEM}>{storage.detail}</SystemAlert>}
    </>
  );
}

/** The files folder's settings, once they have loaded. */
function StorageSettings() {
  const query = useSystemStorage();
  if (query.isError) {
    return (
      <SystemErrorState
        row
        title="Couldn't load the files folder"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data === undefined) {
    return (
      <div className="border-border border-t py-4.5">
        <Skeleton className="h-10 w-full max-w-md" />
      </div>
    );
  }
  return <StorageRows storage={query.data} />;
}

/**
 * Starts the setup walkthrough again: marks it unfinished, at its first step, and opens `/setup`,
 * which takes the administrator through the optional features, the server address and Office.
 * Every choice already made stays as it is until a step changes it.
 */
function WalkthroughRow() {
  const router = useRouter();
  const features = useSystemFeatures();
  const update = useUpdateFeatures();
  const configuration = features.data?.configuration;

  function run() {
    if (configuration === undefined) return;
    update.mutate(
      {
        revision: configuration.revision,
        values: configuration.values,
        walkthroughComplete: false,
        walkthroughStep: 0,
      },
      { onSuccess: () => router.replace("/setup" as Route) },
    );
  }

  return (
    <>
      <SettingRow
        label="Setup walkthrough"
        description="Go through the optional features, the server address and Office again, one step at a time."
        align="end"
      >
        <Button
          variant="outline"
          className="max-md:min-h-11"
          disabled={configuration === undefined || update.isPending}
          onClick={run}
        >
          Run walkthrough
        </Button>
      </SettingRow>
      {update.isError ? (
        <SystemAlert className={ROW_PROBLEM}>{describeApiError(update.error)}</SystemAlert>
      ) : null}
    </>
  );
}

/**
 * Admin page: `System > General`. The installation-wide settings that are
 * neither a feature nor a sidecar, one row each: the address fdrive is
 * reached at, the files folder (`FDRIVE_STORAGE_ROOT`) with its name, how
 * long Trash keeps an item, and the way back into the setup walkthrough.
 */
export function GeneralPage() {
  const publicUrl = useSystemPublicUrl();
  const storage = useSystemStorage();
  const updatedAt = Math.max(publicUrl.dataUpdatedAt, storage.dataUpdatedAt);

  return (
    <SystemPage
      title="General"
      description="Settings for the whole installation. They apply to every user and login."
      lastUpdated={updatedAt > 0 ? new Date(updatedAt) : null}
    >
      {/* One block: the rows bring their own hairlines, so the sheet's gap must not part them. */}
      <div data-slot="general-settings">
        <PublicUrlCard />
        <StorageSettings />
        <TrashSettingsCard />
        <WalkthroughRow />
      </div>
    </SystemPage>
  );
}
