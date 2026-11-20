"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SettingRow } from "@/components/shell/page-layout";
import { Badge } from "@/components/ui/badge";
import { describeApiError } from "@/lib/api/errors";
import { officeStatus } from "@/lib/system/status";
import { LogSheet } from "./log-sheet";
import { OfficeSettingsFields, useOfficeSettingsDraft } from "./office-settings-card";
import { SettingsSheet, SystemSettingsButton } from "./settings-sheet";
import { StatGrid } from "./stat-grid";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemAlert, SystemLine, SystemNote, SystemSection } from "./system-section";

/**
 * Admin page: `System > Office`. Named `OfficeSystemPage` so it does not
 * clash with the reader/editor components under `components/office`.
 */
export function OfficeSystemPage() {
  const draft = useOfficeSettingsDraft();
  const { query, update, product, values, parsed, dirty, addressMissing } = draft;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const status = query.data ? officeStatus(query.data.status) : null;
  const editors = values?.editingEnabled === true ? values.editorUsernames : [];

  function handleSave() {
    if (!parsed.success) return;
    draft.commit(parsed.data, () => {
      toast.success(`${product} settings saved.`);
      setSettingsOpen(false);
    });
  }

  return (
    <SystemPage
      title="Office"
      description="Browser editing for documents, spreadsheets, and presentations."
      lastUpdated={query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt) : null}
      enabled={query.data?.configuration.enabled ?? true}
      actions={
        <>
          <SystemSettingsButton
            onClick={() => setSettingsOpen(true)}
            disabled={values === undefined}
          />
          <LogSheet subsystem="office" />
        </>
      }
    >
      {query.isError ? (
        <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data === undefined ? (
        <SystemLine role="status">Loading Office settings…</SystemLine>
      ) : (
        <>
          <SystemSection title="Status">
            <SettingRow
              label={product}
              description={
                query.data.status === "ready"
                  ? `${product} is ready.`
                  : query.data.status === "starting"
                    ? `${product} is starting. This resolves on its own once the container is up.`
                    : query.data.status === "off"
                      ? `${product} is turned off.`
                      : `Unable to reach ${product}. Check its container and the setup guide.`
              }
            >
              {status !== null ? <StatusBadge status={status} /> : null}
            </SettingRow>
            {addressMissing ? (
              <SystemAlert row>
                Set the fdrive server address first: the editor opens documents through it.
              </SystemAlert>
            ) : null}
            <SettingRow label="Editors" description="The users who may open documents for editing.">
              {editors.length === 0 ? (
                <p className="text-muted-foreground">Everyone opens documents view-only.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {editors.map((username) => (
                    <Badge key={username} variant="secondary">
                      {username}
                    </Badge>
                  ))}
                </div>
              )}
            </SettingRow>
            <SystemNote>
              <p>
                Close open documents before disabling the editor to avoid interrupting unsaved work.
              </p>
              <a
                className="self-start underline underline-offset-4"
                href="https://github.com/fredrikburmester/fdrive/blob/main/docs/OFFICE.md"
                target="_blank"
                rel="noreferrer"
              >
                Office setup instructions
              </a>
            </SystemNote>
          </SystemSection>

          <SystemSection title="Configuration">
            <StatGrid
              stats={[
                { label: "Product", value: product },
                {
                  label: "Editing",
                  value: query.data.configuration.editingEnabled ? "On" : "Off",
                },
                { label: "Editors", value: editors.length.toLocaleString() },
              ]}
            />
          </SystemSection>

          {update.isError ? <SystemAlert row>{describeApiError(update.error)}</SystemAlert> : null}
        </>
      )}

      <SettingsSheet
        title={`${product} settings`}
        description="Who may edit documents, and whether the editor runs at all."
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        dirty={dirty}
        invalid={!parsed.success || (values?.enabled === true && addressMissing)}
        pending={update.isPending}
        onSave={handleSave}
        onReset={draft.reset}
        validationMessages={
          values?.enabled === true && addressMissing
            ? ["Set the server address on System > General before enabling Office."]
            : []
        }
      >
        <OfficeSettingsFields draft={draft} disabled={update.isPending} />
      </SettingsSheet>
    </SystemPage>
  );
}
