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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
import { formatBytes } from "@/lib/format";
import { formatRelativeTime } from "@/lib/system/format";
import {
  globsFromTextarea,
  globsToTextarea,
  ocrSettingsDirty,
  validateOcrSettings,
} from "@/lib/system/settings";
import { sidecarStatus } from "@/lib/system/status";
import { GlobsField, SettingsFormShell } from "./settings-form";
import { StatCard } from "./stat-card";
import { StatusBadge } from "./status-badge";
import { SystemPage } from "./system-page";

interface SettingsDraft {
  hour: string;
  langs: string;
  excludeGlobs: string;
  maxMb: string;
  keepOriginals: boolean;
}

function draftFromValues(values: OcrSettingsValue): SettingsDraft {
  return {
    hour: String(values.hour),
    langs: values.langs,
    excludeGlobs: globsToTextarea(values.excludeGlobs),
    maxMb: String(values.maxMb),
    keepOriginals: values.keepOriginals,
  };
}

function valuesFromDraft(draft: SettingsDraft): OcrSettingsValue {
  return {
    hour: Number(draft.hour),
    langs: draft.langs,
    excludeGlobs: globsFromTextarea(draft.excludeGlobs),
    maxMb: Number(draft.maxMb),
    keepOriginals: draft.keepOriginals,
  };
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Admin page: `System > OCR`. Schedule, last run, originals, settings, and run-now. */
export function OcrPage() {
  const { data, isLoading, dataUpdatedAt } = useSystemOcr();
  const updateSettings = useUpdateOcrSettings();
  const runNow = useRunOcr();

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [runOpen, setRunOpen] = useState(false);

  useEffect(() => {
    if (data !== undefined) {
      setDraft(draftFromValues(data.settings.values));
    }
  }, [data]);

  const status = data !== undefined ? sidecarStatus(data.configured, data.reachable) : null;
  const draftValues = draft !== null ? valuesFromDraft(draft) : null;
  const dirty =
    draftValues !== null &&
    data !== undefined &&
    ocrSettingsDirty(data.settings.values, draftValues);
  const validationMessages = draftValues !== null ? validateOcrSettings(draftValues) : [];

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
        title="OCR"
        description="Scheduled OCR for scanned PDFs and images."
        lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      >
        <Card>
          <CardHeader>
            <CardTitle>Not configured</CardTitle>
            <CardDescription>
              Set <code className="font-mono">FDRIVE_OCR_URL</code> and bring the compose stack up
              with the <code className="font-mono">ocr</code> profile to enable this page.
            </CardDescription>
          </CardHeader>
        </Card>
      </SystemPage>
    );
  }

  return (
    <SystemPage
      title="OCR"
      description="Scheduled OCR for scanned PDFs and images."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      actions={
        <Button type="button" onClick={() => setRunOpen(true)} disabled={data === undefined}>
          Run now…
        </Button>
      }
    >
      {isLoading || data === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Schedule</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              {status !== null ? <StatusBadge status={status} /> : null}
              <span className="text-sm text-muted-foreground">
                Runs nightly at {data.settings.values.hour.toString().padStart(2, "0")}:00
                {data.stats?.nextRunAt !== null && data.stats?.nextRunAt !== undefined
                  ? ` · next run ${formatRelativeTime(new Date(data.stats.nextRunAt), new Date())}`
                  : ""}
                {data.stats?.running === true ? " · running now" : ""}
              </span>
            </CardContent>
          </Card>

          {data.stats?.lastRun !== null && data.stats?.lastRun !== undefined ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Seen" value={data.stats.lastRun.seen.toLocaleString()} />
              <StatCard label="OCR'd" value={data.stats.lastRun.ocred.toLocaleString()} />
              <StatCard label="Skipped" value={data.stats.lastRun.skipped.toLocaleString()} />
              <StatCard label="Failed" value={data.stats.lastRun.failed.toLocaleString()} />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-2">
            <StatCard
              label="Originals kept"
              value={(data.stats?.originalsCount ?? 0).toLocaleString()}
            />
            <StatCard label="Originals size" value={formatBytes(data.stats?.originalsBytes ?? 0)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
              <CardDescription>Applied on the OCR service's next scheduled run.</CardDescription>
            </CardHeader>
            <CardContent>
              {draft !== null ? (
                <SettingsFormShell
                  dirty={dirty}
                  invalid={validationMessages.length > 0}
                  pending={updateSettings.isPending}
                  onSave={handleSave}
                  onReset={handleReset}
                >
                  <Field>
                    <FieldLabel htmlFor="ocr-hour">Run hour</FieldLabel>
                    <Select
                      value={draft.hour}
                      onValueChange={(value) => setDraft({ ...draft, hour: value ?? draft.hour })}
                    >
                      <SelectTrigger id="ocr-hour">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HOURS.map((hour) => (
                          <SelectItem key={hour} value={String(hour)}>
                            {hour.toString().padStart(2, "0")}:00
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="ocr-langs">Languages</FieldLabel>
                    <Input
                      id="ocr-langs"
                      value={draft.langs}
                      onChange={(event) => setDraft({ ...draft, langs: event.target.value })}
                    />
                    <FieldDescription>e.g. "eng" or "swe+eng".</FieldDescription>
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
                  </Field>
                  <Field orientation="horizontal">
                    <FieldLabel htmlFor="ocr-keep-originals">Keep originals</FieldLabel>
                    <Switch
                      id="ocr-keep-originals"
                      checked={draft.keepOriginals}
                      onCheckedChange={(checked) => setDraft({ ...draft, keepOriginals: checked })}
                    />
                  </Field>
                  {validationMessages.length > 0 ? (
                    <ul className="text-sm text-destructive">
                      {validationMessages.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  ) : null}
                </SettingsFormShell>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}

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
