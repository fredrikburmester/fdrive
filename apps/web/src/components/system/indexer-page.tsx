"use client";

import type { IndexerSettingsValue } from "@fdrive/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
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
  useRebuildIndexerThumbnails,
  useReindex,
  useSystemIndexer,
  useUpdateIndexerSettings,
} from "@/lib/api/system-queries";
import { formatRelativeTime } from "@/lib/system/format";
import {
  globsFromTextarea,
  globsToTextarea,
  indexerSettingsDirty,
  validateIndexerSettings,
} from "@/lib/system/settings";
import { sidecarStatus } from "@/lib/system/status";
import { GlobsField, SettingsFormShell } from "./settings-form";
import { StatCard } from "./stat-card";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";

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

/** Admin page: `System > Indexer`. Health, stats, settings, reindex, and thumbnail rebuild. */
export function IndexerPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemIndexer();
  const updateSettings = useUpdateIndexerSettings();
  const reindex = useReindex();
  const rebuildThumbnails = useRebuildIndexerThumbnails();

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [reindexOpen, setReindexOpen] = useState(false);
  const [reindexRoot, setReindexRoot] = useState<string | undefined>(undefined);
  const [reindexPath, setReindexPath] = useState("");
  const [reindexThumbnails, setReindexThumbnails] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuildRoot, setRebuildRoot] = useState(ALL_ROOTS);
  const [rebuildPath, setRebuildPath] = useState("");
  const [rebuildForce, setRebuildForce] = useState(false);

  useEffect(() => {
    if (data !== undefined) {
      setDraft(draftFromValues(data.settings.values));
    }
  }, [data]);

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

  const thumbnailRebuild = data?.stats?.thumbnailRebuild;
  const thumbnailRebuildHint =
    thumbnailRebuild?.running === true
      ? `Rebuilding… ${thumbnailRebuild.processed.toLocaleString()} of ${thumbnailRebuild.total.toLocaleString()}`
      : undefined;

  const draftValues = draft !== null ? valuesFromDraft(draft) : null;
  const dirty =
    draftValues !== null &&
    data !== undefined &&
    indexerSettingsDirty(data.settings.values, draftValues);
  const validationMessages = draftValues !== null ? validateIndexerSettings(draftValues) : [];

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
    if (reindexRoot === undefined) {
      return;
    }
    reindex.mutate(
      {
        root: reindexRoot,
        ...(reindexPath.trim().length > 0 ? { path: reindexPath.trim() } : {}),
        ...(reindexThumbnails ? { thumbnails: true } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success(
            `Marked ${result.marked} file${result.marked === 1 ? "" : "s"} for reindex.`,
          );
          setReindexOpen(false);
          setReindexPath("");
          setReindexThumbnails(false);
        },
        onError: (err) => toast.error(describeApiError(err)),
      },
    );
  }

  function handleRebuildConfirm() {
    rebuildThumbnails.mutate(
      {
        ...(rebuildRoot !== ALL_ROOTS ? { root: rebuildRoot } : {}),
        ...(rebuildPath.trim().length > 0 ? { path: rebuildPath.trim() } : {}),
        ...(rebuildForce ? { force: true } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success(
            result.total > 0
              ? `Rebuilding ${result.total} thumbnail${result.total === 1 ? "" : "s"}…`
              : "No thumbnails need rebuilding.",
          );
          setRebuildOpen(false);
          setRebuildRoot(ALL_ROOTS);
          setRebuildPath("");
          setRebuildForce(false);
        },
        onError: (err) => toast.error(describeApiError(err)),
      },
    );
  }

  return (
    <SystemPage
      title="Indexer"
      description="Roots, scan status, and extraction settings for the fdrive indexer."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      actions={
        <>
          <Button type="button" variant="outline" onClick={() => setRebuildOpen(true)}>
            Rebuild thumbnails
          </Button>
          <Button
            type="button"
            onClick={() => setReindexOpen(true)}
            disabled={rootNames.length === 0}
          >
            Reindex…
          </Button>
        </>
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
              <CardDescription>
                {data.configured
                  ? "The indexer's internal API, per configured root."
                  : "FDRIVE_INDEXER_URL is not set."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              {status !== null ? <StatusBadge status={status} /> : null}
              {rootNames.map((root) => (
                <Badge key={root} variant={watcher[root] ? "secondary" : "outline"}>
                  {root} · watcher {watcher[root] ? "on" : "off"}
                </Badge>
              ))}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Files" value={totalFiles.toLocaleString()} />
            <StatCard label="With text" value={withText.toLocaleString()} />
            <StatCard label="Chunks" value={totalChunks.toLocaleString()} />
            <StatCard label="Embedded" value={totalEmbedded.toLocaleString()} />
            <StatCard
              label="Thumbnails"
              value={(data.stats?.thumbnails ?? 0).toLocaleString()}
              {...(thumbnailRebuildHint !== undefined ? { hint: thumbnailRebuildHint } : {})}
            />
            <StatCard label="Queue depth" value={(data.stats?.queueDepth ?? 0).toLocaleString()} />
          </div>

          {roots.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Counts by status</CardTitle>
              </CardHeader>
              <CardContent>
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
              </CardContent>
            </Card>
          ) : null}

          {roots.some((root) => root.lastScan !== null) ? (
            <Card>
              <CardHeader>
                <CardTitle>Last scan</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
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
              </CardContent>
            </Card>
          ) : null}

          {(data.stats?.errorsSample.length ?? 0) > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Recent errors</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-sm">
                  {data.stats?.errorsSample.map((sample) => (
                    <li key={sample.path} className="flex flex-col">
                      <span className="font-mono text-xs">{sample.path}</span>
                      <span className="text-muted-foreground">
                        {sample.error ?? "unknown error"}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
              <CardDescription>Applied on the indexer's next scan cycle.</CardDescription>
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
                      onChange={(event) =>
                        setDraft({ ...draft, tesseractLangs: event.target.value })
                      }
                    />
                    <FieldDescription>e.g. "eng" or "swe+eng".</FieldDescription>
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
              <Select
                value={reindexRoot}
                onValueChange={(value) => setReindexRoot(value ?? undefined)}
              >
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
            <Field orientation="horizontal">
              <FieldLabel htmlFor="reindex-thumbnails">Also regenerate thumbnails</FieldLabel>
              <Checkbox
                id="reindex-thumbnails"
                checked={reindexThumbnails}
                onCheckedChange={setReindexThumbnails}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReindexOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={reindexRoot === undefined || reindex.isPending}
              onClick={handleReindexConfirm}
            >
              Reindex
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rebuildOpen} onOpenChange={setRebuildOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rebuild thumbnails</DialogTitle>
            <DialogDescription>
              Regenerates preview images for photos, PDFs, and videos. Text and search data are not
              touched.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <Field>
              <FieldLabel htmlFor="rebuild-root">Root</FieldLabel>
              <Select
                value={rebuildRoot}
                onValueChange={(value) => setRebuildRoot(value ?? ALL_ROOTS)}
              >
                <SelectTrigger id="rebuild-root">
                  <SelectValue />
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
            </Field>
            <Field>
              <FieldLabel htmlFor="rebuild-path">Path (optional)</FieldLabel>
              <Input
                id="rebuild-path"
                value={rebuildPath}
                onChange={(event) => setRebuildPath(event.target.value)}
                placeholder="Leave empty to rebuild the whole root"
              />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="rebuild-force">Regenerate existing thumbnails</FieldLabel>
              <Switch id="rebuild-force" checked={rebuildForce} onCheckedChange={setRebuildForce} />
            </Field>
            <FieldDescription>
              Off only fills in thumbnails missing on disk; on deletes and rewrites every thumbnail
              in scope.
            </FieldDescription>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRebuildOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={rebuildThumbnails.isPending}
              onClick={handleRebuildConfirm}
            >
              Rebuild
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SystemPage>
  );
}
