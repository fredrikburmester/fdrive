"use client";

import type { OcrSettingsValue } from "@fdrive/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";

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

/** Admin page: `System > OCR`. Schedule, last run, originals, settings, and run-now. */
export function OcrPage() {
  const { formatBytes } = useFormatters();
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemOcr();
  const updateSettings = useUpdateOcrSettings();
  const runNow = useRunOcr();

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const status = data !== undefined ? sidecarStatus(data.configured, data.reachable) : null;
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
      >
        <SystemSection
          title="Not configured"
          description={
            <>
              Set <code className="font-mono">FDRIVE_OCR_URL</code> and bring the compose stack up
              with the <code className="font-mono">ocr</code> profile to enable this page.
            </>
          }
        />
      </SystemPage>
    );
  }

  return (
    <SystemPage
      title="Searchable PDFs"
      description="Scheduled OCR for scanned PDFs."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      feature="pdfOcr"
      actions={
        <>
          <Button type="button" onClick={() => setRunOpen(true)} disabled={data === undefined}>
            Run now
          </Button>
          <SystemSettingsButton onClick={() => setSettingsOpen(true)} disabled={draft === null} />
          <LogSheet subsystem="ocr" />
        </>
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <SystemSection title="Schedule" contentClassName="flex-row flex-wrap items-center gap-3">
            {status !== null ? <StatusBadge status={status} /> : null}
            <span className="text-sm text-muted-foreground">
              Runs nightly at {data.settings.values.hour.toString().padStart(2, "0")}:00
              {data.stats?.nextRunAt !== null && data.stats?.nextRunAt !== undefined
                ? ` · next run ${formatRelativeTime(new Date(data.stats.nextRunAt), new Date())}`
                : ""}
              {data.stats?.running === true ? " · running now" : ""}
            </span>
          </SystemSection>

          {data.stats?.lastRun !== null && data.stats?.lastRun !== undefined ? (
            <StatGrid
              stats={[
                { label: "Seen", value: data.stats.lastRun.seen.toLocaleString() },
                { label: "OCR'd", value: data.stats.lastRun.ocred.toLocaleString() },
                { label: "Skipped", value: data.stats.lastRun.skipped.toLocaleString() },
                { label: "Failed", value: data.stats.lastRun.failed.toLocaleString() },
              ]}
            />
          ) : null}

          <SystemSection
            title="Kept originals"
            description={
              data.settings.values.keepOriginals
                ? "The file each rewrite replaced, kept so a rewrite can be undone."
                : "Originals are not being kept, so rewrites from now on cannot be undone."
            }
            actions={<OcrOriginalsSheet disabled={!data.reachable} />}
          >
            <StatGrid
              stats={[
                {
                  label: "Originals kept",
                  value: (data.stats?.originalsCount ?? 0).toLocaleString(),
                },
                { label: "Originals size", value: formatBytes(data.stats?.originalsBytes ?? 0) },
              ]}
            />
          </SystemSection>
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
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={runNow.isPending} onClick={handleRunConfirm}>
              Run now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SystemPage>
  );
}
