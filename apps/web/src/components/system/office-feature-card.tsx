"use client";

import { OfficeSettingsUpdateRequest } from "@fdrive/contracts";
import type { Route } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { OFFICE_PAGE } from "@/lib/system/pages";
import { useOfficeSettingsDraft } from "./office-settings-card";
import { SystemErrorState } from "./system-error-state";

/**
 * Office's card on the Features page. It sits alongside the six feature
 * toggles and works the same way — on or off, with a link to the page where
 * the rest of its settings live — even though Office is not a `FeatureId`.
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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{product}</CardTitle>
          <div className="flex items-center gap-3">
            {query.data ? <Badge variant="secondary">{query.data.status}</Badge> : null}
            <Link href={OFFICE_PAGE.href as Route} className="text-sm underline">
              Open Office
            </Link>
          </div>
        </div>
        <CardDescription>
          Open documents, spreadsheets, and presentations in your browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isError ? (
          <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : values ? (
          <>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="enable-office">Enable {product}</FieldLabel>
              <Switch
                id="enable-office"
                checked={values.enabled}
                disabled={busy}
                onCheckedChange={draft.setEnabled}
              />
            </Field>
            <FieldDescription>
              Documents stay in SFTPGo. No processing storage mount is needed. The bundled editor
              uses additional memory while enabled.
            </FieldDescription>
            <FieldDescription>
              Editing permission and the list of editors live on the Office page.
            </FieldDescription>
            {values.enabled && addressMissing ? (
              <p role="alert" className="text-sm text-destructive">
                Set the fdrive server address first: the editor opens documents through it.
              </p>
            ) : null}
            {update.isError ? (
              <div role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
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
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button disabled={busy || (values.enabled && addressMissing)} onClick={save}>
                {update.isPending ? "Saving…" : `Save ${product} settings`}
              </Button>
            </div>
          </>
        ) : (
          <p role="status">Loading Office settings…</p>
        )}
      </CardContent>
    </Card>
  );
}
