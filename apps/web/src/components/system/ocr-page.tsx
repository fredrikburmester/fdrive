"use client";

import type { OcrSettingsValue } from "@fdrive/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SheetColumns } from "@/components/shell/list-sheet";
import { SettingRow } from "@/components/shell/page-layout";
import { BarList, Code, type Fact, FactList } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { useRunOcr, useSystemOcr, useUpdateOcrSettings } from "@/lib/api/system-queries";
import { formatRelativeTime } from "@/lib/system/format";
import {
  globsFromTextarea,
  globsToTextarea,
  ocrSettingsDirty,
  validateOcrSettings,
} from "@/lib/system/settings";
import { sidecarStatus } from "@/lib/system/status";
import { useFormatters } from "@/lib/use-format-preferences";
import { LogSheet } from "./log-sheet";
import { OcrOriginalsSheet } from "./ocr-originals-sheet";
import { GlobsField } from "./settings-form";
import { SettingsSheet, SystemSettingsButton } from "./settings-sheet";
import { StatGrid } from "./stat-grid";
import { StatusBadge as SidecarBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemLine, SystemNote, SystemSection } from "./system-section";

interface SettingsDraft {
  hour: string;
  langs: string;
  excludeGlobs: string;
  maxMb: string;
  keepOriginals: boolean;
  originalsRetentionDays: string;
}

function draftFromValues(values: OcrSettingsValue): SettingsDraft {
  return {
    hour: String(values.hour),
    langs: values.langs,
    excludeGlobs: globsToTextarea(values.excludeGlobs),
    maxMb: String(values.maxMb),
    keepOriginals: values.keepOriginals,
    originalsRetentionDays: String(values.originalsRetentionDays),
  };
}

function valuesFromDraft(draft: SettingsDraft): OcrSettingsValue {
  return {
    hour: Number(draft.hour),
    langs: draft.langs,
    excludeGlobs: globsFromTextarea(draft.excludeGlobs),
    maxMb: Number(draft.maxMb),
    keepOriginals: draft.keepOriginals,
    originalsRetentionDays: Number(draft.originalsRetentionDays),
  };
}

const HOUR_ITEMS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${hour.toString().padStart(2, "0")}:00`,
}));

/**
 * Admin page: `System > Searchable PDFs`. The OCR service's state, its last run, the originals
 * it keeps, its settings and a run-now action.
 */
export function OcrPage() {
  const { formatBytes } = useFormatters();
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemOcr();
  const updateSettings = useUpdateOcrSettings();
  const runNow = useRunOcr();

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const status = data !== undefined ? sidecarStatus(data.configured, data.reachable) : null;
  const stats = data?.stats;
  const lastRun = stats?.lastRun ?? null;
  const draftValues = draft !== null ? valuesFromDraft(draft) : null;
  const dirty =
    draftValues !== null &&
    data !== undefined &&
    ocrSettingsDirty(data.settings.values, draftValues);
  const validationMessages = draftValues !== null ? validateOcrSettings(draftValues) : [];

  // The page polls every 5 seconds; reseeding the draft from each response
  // would wipe whatever is being typed in the open sheet, so a dirty draft
  // is left alone until it is saved or reset.
  useEffect(() => {
    if (data !== undefined && !dirty) {
      setDraft(draftFromValues(data.settings.values));
    }
  }, [data, dirty]);

  function handleSave() {
    if (draftValues === null) {
      return;
    }
    updateSettings.mutate(draftValues, {
      onSuccess: () => toast.success("OCR settings saved."),
      onError: (err) => toast.error(describeApiError(err)),
    });
  }

  function handleReset() {
    if (data !== undefined) {
      setDraft(draftFromValues(data.settings.values));
    }
  }

  function handleRunConfirm() {
    runNow.mutate(undefined, {
      onSuccess: () => {
        toast.success("OCR run started.");
        setRunOpen(false);
      },
      onError: (err) => toast.error(describeApiError(err)),
    });
  }

  if (!isLoading && data !== undefined && !data.configured) {
    return (
      <SystemPage
        title="Searchable PDFs"
        description="Scheduled OCR for scanned PDFs."
        lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
        feature="pdfOcr"
        badges={<SidecarBadge status="not_configured" />}
      >
        <SystemNote>
          <p>
            Set <Code>FDRIVE_OCR_URL</Code> and bring the compose stack up with the <Code>ocr</Code>{" "}
            profile to enable this page.
          </p>
        </SystemNote>
      </SystemPage>
    );
  }

  const lastRunSummary =
    lastRun === null
      ? "OCR has not run yet."
      : `Started ${formatRelativeTime(new Date(lastRun.startedAt), new Date())} · ${lastRun.seen.toLocaleString()} ${lastRun.seen === 1 ? "PDF" : "PDFs"} seen`;

  const scheduleFacts: Fact[] = [];
  if (data !== undefined) {
    scheduleFacts.push({
      label: "Runs",
      value: `Nightly at ${data.settings.values.hour.toString().padStart(2, "0")}:00`,
    });
  }
  if (stats?.nextRunAt !== null && stats?.nextRunAt !== undefined) {
    scheduleFacts.push({
      label: "Next run",
      value: formatRelativeTime(new Date(stats.nextRunAt), new Date()),
    });
  }

  return (
    <SystemPage
      title="Searchable PDFs"
      description="Scheduled OCR for scanned PDFs."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      feature="pdfOcr"
      badges={
        status === null || error !== null ? null : (
          <>
            <SidecarBadge status={status} />
            {stats?.running === true ? <StatusBadge>Running now</StatusBadge> : null}
          </>
        )
      }
      actions={
        <>
          <SystemSettingsButton onClick={() => setSettingsOpen(true)} disabled={draft === null} />
          <LogSheet subsystem="ocr" />
          <Button
            type="button"
            size="lg"
            onClick={() => setRunOpen(true)}
            disabled={data === undefined}
          >
            Run OCR
          </Button>
        </>
      }
    >
      {isLoading ? (
        <SystemLine role="status">Loading…</SystemLine>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          {stats === undefined ? (
            <SystemNote>
              <p>
                The OCR service is not reporting. Its last run and the originals it keeps show here
                when it answers again.
              </p>
            </SystemNote>
          ) : (
            <StatGrid
              stats={[
                { label: "Originals kept", value: stats.originalsCount.toLocaleString() },
                { label: "Originals size", value: formatBytes(stats.originalsBytes) },
              ]}
            />
          )}

          <SheetColumns>
            {stats === undefined ? null : (
              <SystemSection title="Last run" description={lastRunSummary}>
                {lastRun === null ? null : (
                  <BarList
                    total={lastRun.seen}
                    items={[
                      { label: "OCR'd", value: lastRun.ocred, tone: "success" },
                      { label: "Skipped", value: lastRun.skipped },
                      { label: "Failed", value: lastRun.failed, tone: "danger" },
                    ]}
                  />
                )}
              </SystemSection>
            )}
            <SystemSection title="Schedule">
              <FactList facts={scheduleFacts} />
            </SystemSection>
          </SheetColumns>

          <SettingRow
            label="Kept originals"
            description={
              data.settings.values.keepOriginals
                ? "The file each rewrite replaced, kept so a rewrite can be undone."
                : "Originals are not being kept, so rewrites from now on cannot be undone."
            }
            align="end"
          >
            <OcrOriginalsSheet disabled={!data.reachable} />
          </SettingRow>
        </>
      )}

      <SettingsSheet
        title="OCR settings"
        description="Applied on the OCR service's next scheduled run."
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        dirty={dirty}
        invalid={validationMessages.length > 0}
        pending={updateSettings.isPending}
        onSave={handleSave}
        onReset={handleReset}
        validationMessages={validationMessages}
      >
        {draft !== null ? (
          <>
            <Field>
              <FieldLabel htmlFor="ocr-hour">Run hour</FieldLabel>
              <Select
                items={HOUR_ITEMS}
                value={draft.hour}
                onValueChange={(value) => setDraft({ ...draft, hour: value ?? draft.hour })}
              >
                <SelectTrigger id="ocr-hour">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_ITEMS.map((hour) => (
                    <SelectItem key={hour.value} value={hour.value}>
                      {hour.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Hour of the day, in the server's time zone, when the nightly pass starts.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ocr-langs">Languages</FieldLabel>
              <Input
                id="ocr-langs"
                value={draft.langs}
                onChange={(event) => setDraft({ ...draft, langs: event.target.value })}
              />
              <FieldDescription>
                Tesseract language codes joined with "+", e.g. "swe+eng". Each language must already
                be installed in the OCR image.
              </FieldDescription>
            </Field>
            <GlobsField
              id="ocr-exclude-globs"
              label="Exclude globs"
              value={draft.excludeGlobs}
              onChange={(value) => setDraft({ ...draft, excludeGlobs: value })}
              description="Paths matching any of these are never OCR'd."
            />
            <Field>
              <FieldLabel htmlFor="ocr-max-mb">Max file size (MB)</FieldLabel>
              <Input
                id="ocr-max-mb"
                type="number"
                min={1}
                value={draft.maxMb}
                onChange={(event) => setDraft({ ...draft, maxMb: event.target.value })}
              />
              <FieldDescription>PDFs larger than this are skipped.</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="ocr-keep-originals">Keep originals</FieldLabel>
                <FieldDescription>
                  When OCR rewrites a PDF to add a text layer, the file it replaced is kept, and can
                  be put back from Kept originals. Turning this off saves disk space but makes every
                  later rewrite irreversible.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="ocr-keep-originals"
                checked={draft.keepOriginals}
                onCheckedChange={(checked) => setDraft({ ...draft, keepOriginals: checked })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ocr-originals-retention">Keep originals for (days)</FieldLabel>
              <Input
                id="ocr-originals-retention"
                type="number"
                min={0}
                value={draft.originalsRetentionDays}
                onChange={(event) =>
                  setDraft({ ...draft, originalsRetentionDays: event.target.value })
                }
              />
              <FieldDescription>
                Each pass deletes kept originals older than this. 0 keeps them forever.
              </FieldDescription>
            </Field>
          </>
        ) : null}
      </SettingsSheet>

      <AlertDialog open={runOpen} onOpenChange={setRunOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run OCR now?</AlertDialogTitle>
            <AlertDialogDescription>
              Starts an OCR pass immediately instead of waiting for the nightly schedule.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="max-md:min-h-11"
              disabled={runNow.isPending}
              onClick={handleRunConfirm}
            >
              Run OCR
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SystemPage>
  );
}
