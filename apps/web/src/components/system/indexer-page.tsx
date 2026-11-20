"use client";

import type { IndexerSettingsValue } from "@fdrive/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SheetColumns } from "@/components/shell/list-sheet";
import { SettingRow } from "@/components/shell/page-layout";
import { BarList, type BarListItem, Code, FactList } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import {
  useClearIndex,
  useReindex,
  useSystemFeatures,
  useSystemIndexer,
  useSystemMaintenanceBusy,
  useUpdateFeatures,
  useUpdateIndexerSettings,
} from "@/lib/api/system-queries";
import { changeFeature, FEATURE_DESCRIPTIONS } from "@/lib/system/features";
import { formatRelativeTime } from "@/lib/system/format";
import { describeMaintenanceError } from "@/lib/system/maintenance";
import {
  globsFromTextarea,
  globsToTextarea,
  indexerSettingsDirty,
  validateIndexerSettings,
} from "@/lib/system/settings";
import { sidecarStatus } from "@/lib/system/status";
import { LogSheet } from "./log-sheet";
import { MaintenanceProgress } from "./maintenance-progress";
import { GlobsField } from "./settings-form";
import { SettingsSheet, SystemSettingsButton } from "./settings-sheet";
import { StatGrid } from "./stat-grid";
import { StatusBadge as SidecarBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemLine, SystemNote, SystemSection } from "./system-section";

interface SettingsDraft {
  scanIntervalSeconds: string;
  workers: string;
  textExcludeGlobs: string;
  ocrImageGlobs: string;
  tesseractLangs: string;
}

function draftFromValues(values: IndexerSettingsValue): SettingsDraft {
  return {
    scanIntervalSeconds: String(values.scanIntervalSeconds),
    workers: String(values.workers),
    textExcludeGlobs: globsToTextarea(values.textExcludeGlobs),
    ocrImageGlobs: globsToTextarea(values.ocrImageGlobs),
    tesseractLangs: values.tesseractLangs,
  };
}

function valuesFromDraft(draft: SettingsDraft): IndexerSettingsValue {
  return {
    scanIntervalSeconds: Number(draft.scanIntervalSeconds),
    workers: Number(draft.workers),
    textExcludeGlobs: globsFromTextarea(draft.textExcludeGlobs),
    ocrImageGlobs: globsFromTextarea(draft.ocrImageGlobs),
    tesseractLangs: draft.tesseractLangs,
  };
}

/** What the indexer calls a file's text state, in the order the bars list them. */
const STATUS_LABELS: Record<string, string> = {
  indexed: "Indexed",
  no_text: "No text",
  excluded: "Excluded",
  partial: "Partial",
  none: "None",
  pending: "Pending",
};
const STATUS_ORDER = Object.keys(STATUS_LABELS);

/** A state this page has no name for, as words: `disabled:text` reads "Disabled text". */
function statusLabel(status: string): string {
  const words = status.replace(/[_:]+/g, " ").trim();
  return STATUS_LABELS[status] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where a state sits among the bars: the known ones first, failures last. */
function statusRank(status: string): number {
  if (status === "error") return STATUS_ORDER.length + 1;
  const known = STATUS_ORDER.indexOf(status);
  return known === -1 ? STATUS_ORDER.length : known;
}

/** One bar per text state: indexed files in green, failed ones in red at the end. */
function statusBars(counts: Record<string, number>): BarListItem[] {
  return Object.entries(counts)
    .sort(([a], [b]) => statusRank(a) - statusRank(b))
    .map(([status, value]) => ({
      label: statusLabel(status),
      value,
      tone: status === "indexed" ? "success" : status === "error" ? "danger" : "neutral",
    }));
}

/**
 * Search OCR is the indexer's work and has no page of its own, so its switch is a row of this
 * sheet. It saves at once, like the area's own switch in the header.
 */
function SearchOcrRow() {
  const features = useSystemFeatures();
  const update = useUpdateFeatures();
  const configuration = features.data?.configuration;
  if (configuration === undefined) return null;
  const info = FEATURE_DESCRIPTIONS.searchOcr;
  return (
    <SettingRow label={info.title} description={info.description} align="end">
      <Switch
        aria-label={`Enable ${info.title.toLowerCase()}`}
        title={`${info.cost} ${info.dependency}`}
        checked={configuration.values.searchOcr}
        disabled={update.isPending}
        onCheckedChange={(checked) =>
          update.mutate(
            {
              revision: configuration.revision,
              values: changeFeature(configuration.values, "searchOcr", checked),
              walkthroughComplete: configuration.walkthroughComplete,
              walkthroughStep: configuration.walkthroughStep ?? 0,
            },
            { onError: (err) => toast.error(describeApiError(err)) },
          )
        }
      />
    </SettingRow>
  );
}

/**
 * Admin page: `System > Full-text search`. The indexer's health and numbers, its settings,
 * reindexing and clearing the index.
 */
export function IndexerPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemIndexer();
  const updateSettings = useUpdateIndexerSettings();
  const reindex = useReindex();
  const clearIndex = useClearIndex();
  const busy = useSystemMaintenanceBusy(data?.stats) || reindex.isPending || clearIndex.isPending;
  const unavailable = !data?.reachable || error !== null;

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [reindexOpen, setReindexOpen] = useState(false);
  const [reindexPath, setReindexPath] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const [clearPath, setClearPath] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const status = data !== undefined ? sidecarStatus(data.configured, data.reachable) : null;
  const health = data?.health;
  const stats = data?.stats;
  const counts = stats?.countsByStatus ?? {};
  const lastScan = stats?.lastScan ?? null;
  const totalFiles = Object.values(counts).reduce((a, b) => a + b, 0);
  const withText = (counts.indexed ?? 0) + (counts.partial ?? 0);
  const bars = statusBars(counts);

  const draftValues = draft !== null ? valuesFromDraft(draft) : null;
  const dirty =
    draftValues !== null &&
    data !== undefined &&
    indexerSettingsDirty(data.settings.values, draftValues);
  const validationMessages = draftValues !== null ? validateIndexerSettings(draftValues) : [];

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
      onSuccess: () => toast.success("Full-text search settings saved."),
      onError: (err) => toast.error(describeApiError(err)),
    });
  }

  function handleReset() {
    if (data !== undefined) {
      setDraft(draftFromValues(data.settings.values));
    }
  }

  function handleReindexConfirm() {
    reindex.mutate(reindexPath.trim().length > 0 ? { path: reindexPath.trim() } : {}, {
      onSuccess: (result) => {
        toast.success(`Marked ${result.marked} file${result.marked === 1 ? "" : "s"} for reindex.`);
        setReindexOpen(false);
        setReindexPath("");
      },
      onError: (err) => toast.error(describeApiError(err)),
    });
  }

  function handleClearConfirm() {
    clearIndex.mutate(clearPath.trim() ? { path: clearPath.trim() } : {}, {
      onSuccess: () => {
        toast.success("Index clear started.");
        setClearOpen(false);
        setClearPath("");
      },
      onError: (err) => toast.error(describeMaintenanceError(err)),
    });
  }

  return (
    <SystemPage
      title="Full-text search"
      description="Search by file name and by the text inside documents."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      // Full-text search is this area's own feature. The indexer also does the work of the
      // other three, so its numbers stay on screen while any of them is on.
      feature={["textSearch", "searchOcr", "thumbnails", "imageSearch"]}
      badges={
        status === null || error !== null ? null : (
          <>
            <SidecarBadge status={status} />
            {health !== undefined ? (
              <StatusBadge tone={health.watcher ? "neutral" : "off"}>
                Watcher {health.watcher ? "on" : "off"}
              </StatusBadge>
            ) : null}
            {lastScan !== null ? (
              <StatusBadge>
                Scan {formatRelativeTime(new Date(lastScan.startedAt), new Date())}
              </StatusBadge>
            ) : null}
          </>
        )
      }
      actions={
        <>
          <SystemSettingsButton onClick={() => setSettingsOpen(true)} disabled={draft === null} />
          <LogSheet subsystem="indexer" />
          <Button
            type="button"
            size="lg"
            onClick={() => setReindexOpen(true)}
            disabled={unavailable || busy}
          >
            Reindex
          </Button>
        </>
      }
      footer={
        <>
          <p className="min-w-0 flex-[1_1_16rem] text-muted-foreground">
            Clearing removes the search index only. Your files are not touched.
          </p>
          <Button
            type="button"
            variant="destructive"
            size="lg"
            className="ml-auto sheet:px-2"
            disabled={unavailable || busy}
            onClick={() => setClearOpen(true)}
          >
            Clear index
          </Button>
        </>
      }
    >
      {isLoading ? (
        <SystemLine>Loading…</SystemLine>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <MaintenanceProgress title="Index clear" job={stats?.indexClear} />
          {stats === undefined ? (
            <SystemNote>
              <p>
                {data.configured ? (
                  "The indexer is not reporting. Its numbers and last scan show here when it answers again."
                ) : (
                  <>
                    Not configured: set <Code>FDRIVE_INDEXER_URL</Code>.
                  </>
                )}
              </p>
            </SystemNote>
          ) : (
            <>
              <StatGrid
                stats={[
                  { label: "Files", value: totalFiles.toLocaleString() },
                  { label: "With text", value: withText.toLocaleString() },
                  { label: "Chunks", value: stats.chunks.toLocaleString() },
                  { label: "Embedded", value: stats.chunksEmbedded.toLocaleString() },
                  { label: "Queue depth", value: stats.queueDepth.toLocaleString() },
                ]}
              />
              {bars.length > 0 || lastScan !== null ? (
                <SheetColumns>
                  {bars.length > 0 ? (
                    <SystemSection title="Files by status">
                      <BarList items={bars} />
                    </SystemSection>
                  ) : null}
                  {lastScan !== null ? (
                    <SystemSection title="Last scan">
                      <FactList
                        facts={[
                          {
                            label: "Started",
                            value: formatRelativeTime(new Date(lastScan.startedAt), new Date()),
                          },
                          { label: "Seen", value: lastScan.filesSeen.toLocaleString() },
                          { label: "Changed", value: lastScan.filesChanged.toLocaleString() },
                          { label: "Deleted", value: lastScan.filesDeleted.toLocaleString() },
                          {
                            label: "Errors",
                            value: (
                              <span
                                className={lastScan.errors > 0 ? "text-destructive" : undefined}
                              >
                                {lastScan.errors.toLocaleString()}
                              </span>
                            ),
                          },
                        ]}
                      />
                    </SystemSection>
                  ) : null}
                </SheetColumns>
              ) : null}
            </>
          )}
        </>
      )}

      <SearchOcrRow />

      <SettingsSheet
        title="Full-text search settings"
        description="Applied on the indexer's next scan cycle."
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
              <FieldLabel htmlFor="indexer-scan-interval">Scan interval (seconds)</FieldLabel>
              <Input
                id="indexer-scan-interval"
                type="number"
                min={30}
                max={86400}
                value={draft.scanIntervalSeconds}
                onChange={(event) =>
                  setDraft({ ...draft, scanIntervalSeconds: event.target.value })
                }
              />
              <FieldDescription>
                Time between full scans. Changes made in fdrive are indexed right away.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="indexer-workers">Workers</FieldLabel>
              <Input
                id="indexer-workers"
                type="number"
                min={1}
                max={16}
                value={draft.workers}
                onChange={(event) => setDraft({ ...draft, workers: event.target.value })}
              />
              <FieldDescription>
                Number of files extracted concurrently during indexing.
              </FieldDescription>
            </Field>
            <GlobsField
              id="indexer-text-exclude-globs"
              label="Text exclude globs"
              value={draft.textExcludeGlobs}
              onChange={(value) => setDraft({ ...draft, textExcludeGlobs: value })}
              description="Paths matching any of these are never extracted."
            />
            <GlobsField
              id="indexer-ocr-image-globs"
              label="OCR image globs"
              value={draft.ocrImageGlobs}
              onChange={(value) => setDraft({ ...draft, ocrImageGlobs: value })}
              description="Images outside these paths are never OCR'd."
            />
            <Field>
              <FieldLabel htmlFor="indexer-tesseract-langs">Tesseract languages</FieldLabel>
              <Input
                id="indexer-tesseract-langs"
                value={draft.tesseractLangs}
                onChange={(event) => setDraft({ ...draft, tesseractLangs: event.target.value })}
              />
              <FieldDescription>
                Languages used to read text from images, such as "eng" or "swe+eng".
              </FieldDescription>
            </Field>
          </>
        ) : null}
      </SettingsSheet>

      <Dialog open={reindexOpen} onOpenChange={setReindexOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reindex</DialogTitle>
            <DialogDescription>
              Re-extracts text and re-embeds every file in the selected scope on the indexer's next
              scan. This can take a while for a large index.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <Field>
              <FieldLabel htmlFor="reindex-path">Path (optional)</FieldLabel>
              <Input
                id="reindex-path"
                value={reindexPath}
                onChange={(event) => setReindexPath(event.target.value)}
                placeholder="Everything"
              />
              <FieldDescription>
                A file or folder in the files folder, such as alice/Documents.
              </FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReindexOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={unavailable || busy} onClick={handleReindexConfirm}>
              Reindex
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear index data?</DialogTitle>
            <DialogDescription>
              Removes indexed file records, extracted text, chunks, and embeddings in the selected
              scope. Original files, thumbnails, tags, favorites, recents, and history stay. Later
              scheduled scans or file changes can populate the index again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <Field>
              <FieldLabel htmlFor="clear-index-path">Path (optional)</FieldLabel>
              <Input
                id="clear-index-path"
                value={clearPath}
                onChange={(event) => setClearPath(event.target.value)}
                placeholder="Everything"
              />
              <FieldDescription>
                A file or folder in the files folder, such as alice/Documents.
              </FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setClearOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={unavailable || busy || clearIndex.isPending}
              onClick={handleClearConfirm}
            >
              Clear index
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SystemPage>
  );
}
