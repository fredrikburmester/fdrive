"use client";

import type { IndexerSettingsValue } from "@fdrive/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeApiError } from "@/lib/api/errors";
import {
  useClearIndex,
  useReindex,
  useSystemIndexer,
  useSystemMaintenanceBusy,
  useUpdateIndexerSettings,
} from "@/lib/api/system-queries";
import { formatRelativeTime } from "@/lib/system/format";
import { describeMaintenanceError } from "@/lib/system/maintenance";
import {
  globsFromTextarea,
  globsToTextarea,
  indexerSettingsDirty,
  validateIndexerSettings,
} from "@/lib/system/settings";
import { sidecarStatus } from "@/lib/system/status";
import { MaintenanceProgress } from "./maintenance-progress";
import { GlobsField } from "./settings-form";
import { SettingsSheet, SystemSettingsButton } from "./settings-sheet";
import { StatGrid } from "./stat-grid";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";

/** Sentinel `root` select value meaning "every configured root" (the API's `root` omitted). */
const ALL_ROOTS = "__all__";

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

/** Admin page: `System > Indexer`. Health, stats, settings, reindex, and index clearing. */
export function IndexerPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemIndexer();
  const updateSettings = useUpdateIndexerSettings();
  const reindex = useReindex();
  const clearIndex = useClearIndex();
  const busy = useSystemMaintenanceBusy(data?.stats) || reindex.isPending || clearIndex.isPending;
  const unavailable = !data?.reachable || error !== null;

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [reindexOpen, setReindexOpen] = useState(false);
  const [reindexRoot, setReindexRoot] = useState<string | null>(null);
  const [reindexPath, setReindexPath] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const [clearRoot, setClearRoot] = useState(ALL_ROOTS);
  const [clearPath, setClearPath] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const status = data !== undefined ? sidecarStatus(data.configured, data.reachable) : null;
  const roots = data?.stats?.roots ?? [];
  const watcher = data?.health?.watcher ?? {};
  const rootNames = data?.health?.roots ?? roots.map((root) => root.root);

  const totalFiles = roots.reduce(
    (sum, root) => sum + Object.values(root.countsByStatus).reduce((a, b) => a + b, 0),
    0,
  );
  const withText = roots.reduce(
    (sum, root) => sum + (root.countsByStatus.indexed ?? 0) + (root.countsByStatus.partial ?? 0),
    0,
  );
  const totalChunks = roots.reduce((sum, root) => sum + root.chunks, 0);
  const totalEmbedded = roots.reduce((sum, root) => sum + root.chunksEmbedded, 0);

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
      onSuccess: () => toast.success("Indexer settings saved."),
      onError: (err) => toast.error(describeApiError(err)),
    });
  }

  function handleReset() {
    if (data !== undefined) {
      setDraft(draftFromValues(data.settings.values));
    }
  }

  function handleReindexConfirm() {
    if (reindexRoot === null) {
      return;
    }
    reindex.mutate(
      {
        root: reindexRoot,
        ...(reindexPath.trim().length > 0 ? { path: reindexPath.trim() } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success(
            `Marked ${result.marked} file${result.marked === 1 ? "" : "s"} for reindex.`,
          );
          setReindexOpen(false);
          setReindexPath("");
        },
        onError: (err) => toast.error(describeApiError(err)),
      },
    );
  }

  function handleClearConfirm() {
    clearIndex.mutate(
      {
        ...(clearRoot !== ALL_ROOTS ? { root: clearRoot } : {}),
        ...(clearPath.trim() ? { path: clearPath.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success("Index clear started.");
          setClearOpen(false);
          setClearRoot(ALL_ROOTS);
          setClearPath("");
        },
        onError: (err) => toast.error(describeMaintenanceError(err)),
      },
    );
  }

  return (
    <SystemPage
      title="Indexer"
      description="Roots, scan status, and extraction settings for the fdrive indexer."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      feature={["thumbnails", "textSearch", "imageSearch"]}
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={unavailable || busy}
            onClick={() => setClearOpen(true)}
          >
            Clear index
          </Button>
          <Button
            type="button"
            onClick={() => setReindexOpen(true)}
            disabled={rootNames.length === 0 || unavailable || busy}
          >
            Reindex
          </Button>
          <SystemSettingsButton onClick={() => setSettingsOpen(true)} disabled={draft === null} />
          {/* LogSheet mounts here (P9 event log) */}
        </>
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <SystemSection
            title="Status"
            description={
              data.configured
                ? "The indexer's internal API, per configured root."
                : "Not configured: set FDRIVE_INDEXER_URL and FDRIVE_INDEX_ROOTS."
            }
            contentClassName="flex-row flex-wrap items-center gap-3"
          >
            {status !== null ? <StatusBadge status={status} /> : null}
            {rootNames.map((root) => (
              <Badge key={root} variant={watcher[root] ? "secondary" : "outline"}>
                {root} · watcher {watcher[root] ? "on" : "off"}
              </Badge>
            ))}
          </SystemSection>

          <StatGrid
            stats={[
              { label: "Files", value: totalFiles.toLocaleString() },
              { label: "With text", value: withText.toLocaleString() },
              { label: "Chunks", value: totalChunks.toLocaleString() },
              { label: "Embedded", value: totalEmbedded.toLocaleString() },
              { label: "Queue depth", value: (data.stats?.queueDepth ?? 0).toLocaleString() },
            ]}
          />

          <MaintenanceProgress title="Index clear" job={data.stats?.indexClear} />

          {roots.length > 0 ? (
            <SystemSection title="Counts by status">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Root</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roots.flatMap((root) =>
                    Object.entries(root.countsByStatus).map(([status_, count]) => (
                      <TableRow key={`${root.root}-${status_}`}>
                        <TableCell className="font-medium">{root.root}</TableCell>
                        <TableCell>{status_}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {count.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    )),
                  )}
                </TableBody>
              </Table>
            </SystemSection>
          ) : null}

          {roots.some((root) => root.lastScan !== null) ? (
            <SystemSection title="Last scan">
              {roots
                .filter((root) => root.lastScan !== null)
                .map((root) => (
                  <div
                    key={root.root}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
                  >
                    <span className="font-medium">{root.root}</span>
                    <span className="text-muted-foreground">
                      started{" "}
                      {formatRelativeTime(new Date(root.lastScan?.startedAt ?? 0), new Date())}
                    </span>
                    <span className="text-muted-foreground">
                      {root.lastScan?.filesSeen ?? 0} seen · {root.lastScan?.filesChanged ?? 0}{" "}
                      changed · {root.lastScan?.filesDeleted ?? 0} deleted ·{" "}
                      {root.lastScan?.errors ?? 0} errors
                    </span>
                  </div>
                ))}
            </SystemSection>
          ) : null}

          {(data.stats?.errorsSample.length ?? 0) > 0 ? (
            <SystemSection title="Recent errors">
              <ul className="flex flex-col gap-2 text-sm">
                {data.stats?.errorsSample.map((sample) => (
                  <li key={sample.path} className="flex flex-col">
                    <span className="font-mono text-xs">{sample.path}</span>
                    <span className="text-muted-foreground">{sample.error ?? "unknown error"}</span>
                  </li>
                ))}
              </ul>
            </SystemSection>
          ) : null}
        </>
      )}

      <SettingsSheet
        title="Indexer settings"
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
                Time between scheduled scans of every configured root.
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
              <FieldLabel htmlFor="reindex-root">Root</FieldLabel>
              <Select value={reindexRoot} onValueChange={(value) => setReindexRoot(value ?? null)}>
                <SelectTrigger id="reindex-root">
                  <SelectValue placeholder="Select a root" />
                </SelectTrigger>
                <SelectContent>
                  {rootNames.map((root) => (
                    <SelectItem key={root} value={root}>
                      {root}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="reindex-path">Path (optional)</FieldLabel>
              <Input
                id="reindex-path"
                value={reindexPath}
                onChange={(event) => setReindexPath(event.target.value)}
                placeholder="Leave empty to reindex the whole root"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReindexOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={reindexRoot === null || unavailable || busy}
              onClick={handleReindexConfirm}
            >
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
              scope. Original files, thumbnails, tags, favorites, recents, roots, and history stay.
              Later scheduled scans or file changes can populate the index again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <Field>
              <FieldLabel htmlFor="clear-index-root">Root</FieldLabel>
              <Select
                value={clearRoot}
                onValueChange={(value) => {
                  setClearRoot(value ?? ALL_ROOTS);
                  setClearPath("");
                }}
              >
                <SelectTrigger id="clear-index-root">
                  <SelectValue>{clearRoot === ALL_ROOTS ? "All roots" : clearRoot}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ROOTS}>All roots</SelectItem>
                  {rootNames.map((root) => (
                    <SelectItem key={root} value={root}>
                      {root}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Choose all roots or limit removal to one root.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="clear-index-path">Path (optional)</FieldLabel>
              <Input
                id="clear-index-path"
                value={clearPath}
                disabled={clearRoot === ALL_ROOTS}
                onChange={(event) => setClearPath(event.target.value)}
                placeholder="Whole root"
              />
              <FieldDescription>
                Choose a root first, then enter a file or folder path relative to it.
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
