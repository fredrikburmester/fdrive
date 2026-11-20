"use client";

import { TrashSettings } from "@fdrive/contracts";
import { useState } from "react";
import { SettingRow } from "@/components/shell/page-layout";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useTrashSettings, useUpdateTrashSettings } from "@/lib/api/trash-settings-queries";
import { SystemErrorState } from "./system-error-state";
import { SystemAlert, SystemSection } from "./system-section";

const FIELD = "trash-retention-days";

/** The days a draft names, or `null` when it is not a whole number from 1 to 3650. */
function draftDays(draft: string): number | null {
  if (draft.trim() === "") return null;
  const parsed = TrashSettings.safeParse({ retentionDays: Number(draft) });
  return parsed.success ? parsed.data.retentionDays : null;
}

/**
 * Trash's one setting on System > General: how many days it keeps a deleted
 * item before fdrive deletes it permanently. Trash itself is always on.
 */
export function TrashSettingsCard() {
  const query = useTrashSettings();
  const update = useUpdateTrashSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const saved = query.data?.retentionDays;
  const value = draft ?? (saved === undefined ? "" : String(saved));
  const days = draftDays(value);

  function save() {
    if (days === null) return;
    update.mutate({ retentionDays: days }, { onSuccess: () => setDraft(null) });
  }

  return (
    <SystemSection
      title="Trash"
      description="Deleted files wait in each user's Trash, then fdrive deletes them permanently."
    >
      {query.isError ? (
        <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : saved === undefined ? (
        <div className="px-3 py-2.5">
          <Skeleton className="h-8 w-full max-w-md" />
        </div>
      ) : (
        <SettingRow
          label="Days in Trash"
          htmlFor={FIELD}
          description="Items in Trash longer than this are deleted permanently."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={FIELD}
              className="w-28 max-md:min-h-11"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              step={1}
              value={value}
              disabled={update.isPending}
              aria-invalid={days === null}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              className="max-md:min-h-11"
              disabled={update.isPending || days === null || days === saved}
              onClick={save}
            >
              {update.isPending ? "Saving…" : "Save Trash settings"}
            </Button>
          </div>
          {days === null ? (
            <FieldError className="mt-1.5">Enter a whole number from 1 to 3650.</FieldError>
          ) : null}
          {update.isError ? (
            <SystemAlert className="mt-1.5">{describeApiError(update.error)}</SystemAlert>
          ) : null}
        </SettingRow>
      )}
    </SystemSection>
  );
}
