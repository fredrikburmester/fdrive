"use client";

import { useState } from "react";
import { toast } from "sonner";
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
import { SystemSection } from "./system-section";

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
        <p role="status">Loading Office settings…</p>
      ) : (
        <>
          <SystemSection
            title="Status"
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
            {addressMissing ? (
              <p role="alert" className="text-sm text-destructive">
                Set the fdrive server address first: the editor opens documents through it.
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Close open documents before disabling the editor to avoid interrupting unsaved work.
            </p>
            <a
              className="block text-sm underline"
              href="https://github.com/fredrikburmester/fdrive-web/blob/main/docs/OFFICE.md"
              target="_blank"
              rel="noreferrer"
            >
              Office setup instructions
            </a>
          </SystemSection>

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

          <SystemSection
            title="Editors"
            description="SFTPGo usernames allowed to open documents for editing."
            contentClassName="flex-row flex-wrap gap-2"
          >
            {editors.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everyone opens documents view-only.</p>
            ) : (
              editors.map((username) => (
                <Badge key={username} variant="secondary">
                  {username}
                </Badge>
              ))
            )}
          </SystemSection>

          {update.isError ? (
            <div role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
              {describeApiError(update.error)}
            </div>
          ) : null}
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
