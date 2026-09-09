"use client";

import { type OfficeSettings, OfficeSettingsUpdateRequest } from "@fdrive/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { describeApiError } from "@/lib/api/errors";
import { useSystemOffice, useUpdateOfficeSettings } from "@/lib/api/office-settings-queries";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import { SystemErrorState } from "./system-error-state";

export function OfficeSettingsCard({
  onContinue,
  disabled = false,
}: {
  onContinue?: () => void;
  disabled?: boolean;
}) {
  const query = useSystemOffice();
  const address = useSystemPublicUrl();
  const update = useUpdateOfficeSettings();
  const [draft, setDraft] = useState<OfficeSettings | null>(null);
  const [editorsText, setEditorsText] = useState<string | null>(null);
  const saved = query.data?.configuration;
  const stored = draft ?? saved;
  const providerChanged =
    stored?.editingEnabled && stored.editingProviderId !== query.data?.activeProviderId;
  const base =
    stored && providerChanged
      ? { ...stored, editingEnabled: false, editingProviderId: null, editorUsernames: [] }
      : stored;
  const values =
    base && editorsText !== null
      ? {
          ...base,
          editorUsernames: editorsText
            .split("\n")
            .map((name) => name.trim())
            .filter(Boolean),
        }
      : base;
  const busy = disabled || update.isPending;
  const product = query.data?.product === "collabora" ? "Collabora" : "ONLYOFFICE";
  const parsed = OfficeSettingsUpdateRequest.safeParse(values);
  // The editor is told fdrive lives at the server address; without one the
  // api refuses to enable Office, so say so before the owner tries.
  const addressMissing = address.data !== undefined && address.data.url === null;
  const editingMatchesProvider = values?.editingProviderId === query.data?.activeProviderId;
  function change(patch: Partial<OfficeSettings>) {
    if (values) setDraft({ ...values, ...patch });
  }
  function save(skip = false) {
    if (!saved) return;
    if (skip && !saved.enabled) {
      onContinue?.();
      return;
    }
    const input = OfficeSettingsUpdateRequest.safeParse(
      skip ? { ...saved, enabled: false } : values,
    );
    if (!input.success) return;
    update.mutate(input.data, {
      onSuccess: () => {
        setDraft(null);
        setEditorsText(null);
        onContinue?.();
      },
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{product}</CardTitle>
        <CardDescription>
          Open documents, spreadsheets, and presentations in your browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isError ? (
          <>
            <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
            {onContinue ? (
              <Button variant="outline" disabled={busy} onClick={onContinue}>
                Continue without changing {product}
              </Button>
            ) : null}
          </>
        ) : values ? (
          <>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="enable-office">Enable {product}</FieldLabel>
              <Switch
                id="enable-office"
                checked={values.enabled}
                disabled={busy}
                onCheckedChange={(enabled) => {
                  if (enabled) change({ enabled });
                  else {
                    setDraft(saved ? { ...saved, enabled: false } : null);
                    setEditorsText(null);
                  }
                }}
              />
            </Field>
            <FieldDescription>
              Documents stay in SFTPGo. No processing storage mount is needed. The bundled editor
              uses additional memory while enabled.
            </FieldDescription>
            {values.enabled ? (
              <>
                {addressMissing ? (
                  <p role="alert" className="text-sm text-destructive">
                    Set the fdrive server address first: the editor opens documents through it.
                  </p>
                ) : null}
                {(draft || editorsText !== null) && !parsed.success ? (
                  <p role="alert" className="text-sm text-destructive">
                    When editing is enabled, enter at least one allowed username.
                  </p>
                ) : null}
                {providerChanged ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    The SFTPGo provider changed. Choose editors again to enable editing for this
                    server.
                  </p>
                ) : null}
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="office-editing">Allow document editing</FieldLabel>
                  <Switch
                    id="office-editing"
                    checked={values.editingEnabled && editingMatchesProvider}
                    disabled={busy}
                    onCheckedChange={(editingEnabled) => {
                      if (!editingMatchesProvider) setEditorsText("");
                      change({
                        editingEnabled,
                        editingProviderId: query.data?.activeProviderId ?? null,
                        editorUsernames: editingMatchesProvider ? values.editorUsernames : [],
                      });
                    }}
                  />
                </Field>
                <FieldDescription>
                  When off, all documents open for viewing. When on, only the users you list below
                  can edit.
                </FieldDescription>
                {values.editingEnabled && editingMatchesProvider ? (
                  <Field>
                    <FieldLabel htmlFor="office-editors">Users allowed to edit</FieldLabel>
                    <Textarea
                      id="office-editors"
                      disabled={busy}
                      value={editorsText ?? values.editorUsernames.join("\n")}
                      onChange={(event) => {
                        setDraft(values);
                        setEditorsText(event.target.value);
                      }}
                    />
                    <FieldDescription>
                      One SFTPGo username per line. These users can open documents for editing;
                      everyone else gets view-only. Being listed here grants no file access — SFTPGo
                      permissions still apply to saves.
                    </FieldDescription>
                  </Field>
                ) : null}
              </>
            ) : null}
            {saved?.enabled ? (
              <p role="status" className="text-sm text-muted-foreground">
                {query.data?.status === "ready"
                  ? `${product} is ready.`
                  : query.data?.status === "starting"
                    ? `${product} is starting. You can finish setup while it starts.`
                    : `Unable to reach ${product}. Check its container and the setup guide.`}
              </p>
            ) : null}
            {saved?.enabled ? (
              <p className="text-sm text-muted-foreground">
                Close open documents before disabling the editor to avoid interrupting unsaved work.
              </p>
            ) : null}
            <a
              className="block text-sm underline"
              href="https://github.com/fredrikburmester/fdrive-web/blob/main/docs/OFFICE.md"
              target="_blank"
              rel="noreferrer"
            >
              Office setup instructions
            </a>
            {update.isError ? (
              <div role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {describeApiError(update.error)}
                <Button
                  variant="link"
                  onClick={() => {
                    setDraft(null);
                    setEditorsText(null);
                    update.reset();
                    void query.refetch();
                  }}
                >
                  Reload saved settings
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              {onContinue ? (
                <Button variant="outline" disabled={busy} onClick={() => save(true)}>
                  Skip {product}
                </Button>
              ) : null}
              <Button
                disabled={busy || !parsed.success || (values.enabled && addressMissing)}
                onClick={() => save()}
              >
                {update.isPending
                  ? "Saving…"
                  : onContinue
                    ? "Save and continue"
                    : `Save ${product} settings`}
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

export function OfficeReview() {
  const query = useSystemOffice();
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span>{query.data?.product === "collabora" ? "Collabora" : "ONLYOFFICE"}</span>
      <span>
        {query.data
          ? query.data.configuration.enabled
            ? "Enabled"
            : "Off"
          : query.isError
            ? "Status unavailable"
            : "Loading…"}
      </span>
    </div>
  );
}
