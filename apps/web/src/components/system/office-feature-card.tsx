"use client";

import { OfficeSettingsUpdateRequest } from "@fdrive/contracts";
import type { Route } from "next";
import Link from "next/link";
import { SettingRow } from "@/components/shell/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { OFFICE_PAGE } from "@/lib/system/pages";
import { useOfficeSettingsDraft } from "./office-settings-card";
import { SystemAlert } from "./system-section";

/**
 * Office's row on the Features page. It sits under the six feature toggles
 * and works the same way — on or off, with a link to the page where the rest
 * of its settings live — even though Office is not a `FeatureId`. It saves on
 * its own, because Office keeps its own settings record.
 */
export function OfficeFeatureCard({ disabled = false }: { disabled?: boolean }) {
  const draft = useOfficeSettingsDraft();
  const { query, update, product, values, addressMissing } = draft;
  const busy = disabled || update.isPending;

  function save() {
    if (!values) return;
    const input = OfficeSettingsUpdateRequest.safeParse(values);
    if (!input.success) return;
    draft.commit(input.data);
  }

  return (
    <SettingRow
      data-feature="office"
      label={product}
      description="Open documents, spreadsheets, and presentations in your browser."
      className="@2xl:items-start"
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1.5">
        {values ? (
          <Switch
            id="enable-office"
            aria-label={`Enable ${product}`}
            checked={values.enabled}
            disabled={busy}
            onCheckedChange={draft.setEnabled}
          />
        ) : null}
        {query.data ? <Badge variant="secondary">{query.data.status}</Badge> : null}
        <Link href={OFFICE_PAGE.href as Route} className="text-sm underline underline-offset-4">
          Open Office
        </Link>
        {values ? (
          <Button
            variant="outline"
            size="sm"
            className="max-md:min-h-11"
            disabled={busy || (values.enabled && addressMissing)}
            onClick={save}
          >
            {update.isPending ? "Saving…" : `Save ${product} settings`}
          </Button>
        ) : null}
      </div>
      {query.isError ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <SystemAlert>{describeApiError(query.error)}</SystemAlert>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : values ? (
        <>
          <p className="mt-1.5 max-w-3xl text-muted-foreground text-xs">
            Documents stay in your storage. No processing storage mount is needed. The bundled
            editor uses additional memory while enabled. Editing permission and the list of editors
            live on the Office page.
          </p>
          {values.enabled && addressMissing ? (
            <SystemAlert className="mt-1.5">
              Set the fdrive server address first: the editor opens documents through it.
            </SystemAlert>
          ) : null}
          {update.isError ? (
            <SystemAlert className="mt-1.5">
              {describeApiError(update.error)}
              <Button
                variant="link"
                onClick={() => {
                  draft.reset();
                  update.reset();
                  void query.refetch();
                }}
              >
                Reload saved settings
              </Button>
            </SystemAlert>
          ) : null}
        </>
      ) : (
        <p role="status" className="mt-1.5 text-muted-foreground text-xs">
          Loading Office settings…
        </p>
      )}
    </SettingRow>
  );
}
