"use client";

import type { Route } from "next";
import Link from "next/link";
import { toast } from "sonner";
import { SettingActions, SettingRow } from "@/components/shell/page-layout";
import { StatusBadge as Badge } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { officeStatus } from "@/lib/system/status";
import { LogSheet } from "./log-sheet";
import {
  OFFICE_ADDRESS_NOTE,
  OFFICE_CLOSE_NOTE,
  OFFICE_EDITING_NOTE,
  OFFICE_EDITORS_LABEL,
  OFFICE_EDITORS_NOTE,
  OFFICE_GUIDE_URL,
  OfficeEditorChoices,
  type OfficeSettingsDraft,
  useOfficeSettingsDraft,
} from "./office-settings-card";
import { SettingsFormActions } from "./settings-form";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemAlert, SystemLine, SystemSection } from "./system-section";

const GENERAL_ROUTE = "/system/general" as Route;

const linkClassName = "underline underline-offset-4";

function GuideLink() {
  return (
    <a className={linkClassName} href={OFFICE_GUIDE_URL} target="_blank" rel="noreferrer">
      Office setup instructions
    </a>
  );
}

/** The editor has nowhere to send people without a server address: say so, and where to set it. */
function AddressAlert() {
  return (
    <SystemAlert>
      {OFFICE_ADDRESS_NOTE}{" "}
      <Link href={GENERAL_ROUTE} className={linkClassName}>
        Open General
      </Link>
    </SystemAlert>
  );
}

/** A save the server refused, with the way back to what is saved. */
function SaveAlert({ draft }: { draft: OfficeSettingsDraft }) {
  const { query, update } = draft;
  return (
    <SystemAlert>
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
  );
}

/**
 * Admin page: `System > Office`. Named `OfficeSystemPage` so it does not
 * clash with the reader/editor components under `components/office`.
 *
 * Office is not a `FeatureId`: it keeps its own settings record. Its switch
 * sits in the sheet's header where a feature's does and saves at once, and
 * who may edit is a short form under it with its own Save.
 */
export function OfficeSystemPage() {
  const draft = useOfficeSettingsDraft();
  const { query, update, product, saved, values, parsed, dirty, addressMissing } = draft;
  const service = query.data?.status;
  const busy = update.isPending;

  function handleSave() {
    if (!parsed.success) return;
    draft.commit(parsed.data, () => toast.success(`${product} settings saved.`));
  }

  return (
    <SystemPage
      title="Office"
      description="Browser editing for documents, spreadsheets, and presentations."
      lastUpdated={query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt) : null}
      // Neither On nor Off until the settings have loaded.
      {...(saved ? { enabled: saved.enabled } : {})}
      toggle={
        saved ? (
          <Switch
            aria-label={`Enable ${product}`}
            title="Documents stay in your storage. The bundled editor uses additional memory while enabled."
            checked={saved.enabled}
            // Without a server address the API refuses to turn Office on; the off state says why.
            disabled={busy || (!saved.enabled && addressMissing)}
            onCheckedChange={draft.saveEnabled}
          />
        ) : undefined
      }
      offNote={
        <div className="flex flex-col gap-2">
          <p>
            Turning it on starts the bundled {product} editor, so documents, spreadsheets and
            presentations open in the browser. Documents stay in your storage, and the editor uses
            additional memory while enabled.
          </p>
          {addressMissing ? <AddressAlert /> : null}
          {update.isError ? <SaveAlert draft={draft} /> : null}
          <p>
            <GuideLink />
          </p>
        </div>
      }
      badges={
        <>
          {service !== undefined ? <StatusBadge status={officeStatus(service)} /> : null}
          {query.data !== undefined ? <Badge>{product}</Badge> : null}
        </>
      }
      actions={<LogSheet subsystem="office" />}
      footer={
        <>
          <p className="min-w-0 flex-[1_1_16rem] text-muted-foreground">{OFFICE_CLOSE_NOTE}</p>
          <GuideLink />
        </>
      }
    >
      {query.isError ? (
        <SystemErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : values === undefined ? (
        <SystemLine role="status">Loading Office settings…</SystemLine>
      ) : (
        <>
          {update.isError ? <SaveAlert draft={draft} /> : null}
          {addressMissing ? <AddressAlert /> : null}
          {service === "starting" ? (
            <SystemLine role="status">
              {product} is starting. This resolves on its own once the container is up.
            </SystemLine>
          ) : service === "unavailable" ? (
            <SystemAlert>
              Unable to reach {product}. Check its container and the setup guide.
            </SystemAlert>
          ) : null}

          <SystemSection title="Editing">
            <SettingRow
              label="Allow document editing"
              htmlFor="office-editing"
              description={OFFICE_EDITING_NOTE}
              align="end"
            >
              <Switch
                id="office-editing"
                checked={values.editingEnabled}
                disabled={busy}
                onCheckedChange={(editingEnabled) => draft.change({ editingEnabled })}
              />
            </SettingRow>
            {values.editingEnabled ? (
              <SettingRow label={OFFICE_EDITORS_LABEL} description={OFFICE_EDITORS_NOTE}>
                <OfficeEditorChoices
                  draft={draft}
                  values={values}
                  disabled={busy}
                  label={OFFICE_EDITORS_LABEL}
                />
              </SettingRow>
            ) : null}
            <SettingActions>
              {dirty && !parsed.success ? (
                <SystemAlert className="mr-auto min-w-0 flex-[1_1_16rem]">
                  When editing is enabled, choose at least one user.
                </SystemAlert>
              ) : null}
              <div className="flex flex-none items-center gap-2">
                <SettingsFormActions
                  dirty={dirty}
                  invalid={!parsed.success || addressMissing}
                  pending={busy}
                  onSave={handleSave}
                  onReset={draft.reset}
                />
              </div>
            </SettingActions>
          </SystemSection>
        </>
      )}
    </SystemPage>
  );
}
