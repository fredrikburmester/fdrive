"use client";

import type { JobStatus } from "@fdrive/contracts";
import {
  ChevronDown,
  FileArchive,
  FolderOpen,
  PackageOpen,
  RotateCcw,
  UploadCloud,
  X,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { useIsMobile } from "@/hooks/use-mobile";
import { activityTitle } from "@/lib/activity/summary";
import { apiClient } from "@/lib/api/client";
import { pathToHref } from "@/lib/files/path-url";
import { cancelJob, type RetryJobDeps, retryJob } from "@/lib/jobs/actions";
import {
  formatJobProgress,
  jobDisplayName,
  jobOpenFolderPath,
  jobProgressFraction,
  jobStateLabel,
  jobTitle,
} from "@/lib/jobs/format";
import { pollActiveJobs } from "@/lib/jobs/poll";
import { activeJobs, finishedJobs } from "@/lib/jobs/reducer";
import { useJobsStore } from "@/lib/jobs/store";
import type { JobRequest } from "@/lib/jobs/types";
import { estimateSpeed, formatEta, formatSpeed, type ThroughputSample } from "@/lib/upload/format";
import { summarize } from "@/lib/upload/queue";
import { useUploadStore } from "@/lib/upload/store";
import type { UploadItem, UploadStatus } from "@/lib/upload/types";
import { useFormatters } from "@/lib/use-format-preferences";

const SAMPLE_HISTORY_LIMIT = 50;
/**
 * How often the panel re-fetches `apiClient.jobs()` while any job is
 * queued or running, as a safety net alongside the `job` SSE stream (see
 * `pollActiveJobs`).
 */
const JOB_POLL_INTERVAL_MS = 5000;

function toRoute(href: string): Route {
  return href as Route;
}

function statusLabel(status: UploadStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading";
    case "done":
      return "Done";
    case "error":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "cancelled":
      return "Cancelled";
  }
}

function statusVariant(status: UploadStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "done":
      return "secondary";
    case "error":
      return "destructive";
    case "uploading":
      return "default";
    default:
      return "outline";
  }
}

interface UploadRowProps {
  readonly item: UploadItem;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}

function UploadRow({ item, onRetry, onCancel }: UploadRowProps) {
  const isActive = item.status === "queued" || item.status === "uploading";

  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm text-foreground" title={item.relativePath}>
          {item.relativePath}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={statusVariant(item.status)}>{statusLabel(item.status)}</Badge>
          {item.status === "error" && (
            <Button variant="ghost" size="icon-xs" onClick={onRetry} aria-label="Retry upload">
              <RotateCcw />
            </Button>
          )}
          {isActive && (
            <Button variant="ghost" size="icon-xs" onClick={onCancel} aria-label="Cancel upload">
              <X />
            </Button>
          )}
        </div>
      </div>
      {item.status === "uploading" && <Progress value={item.progress * 100} />}
      {item.status === "error" && item.error !== undefined && (
        <p className="truncate text-xs text-destructive">{item.error}</p>
      )}
    </li>
  );
}

function jobStatusVariant(
  state: "queued" | "running" | "done" | "failed" | "cancelled",
): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "done":
      return "secondary";
    case "failed":
      return "destructive";
    case "running":
      return "default";
    default:
      return "outline";
  }
}

interface JobRowProps {
  readonly job: JobStatus;
  readonly request: JobRequest | undefined;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}

function JobRow({ job, request, onCancel, onRetry }: JobRowProps) {
  const { prefs } = useFormatters();
  const isActive = job.state === "queued" || job.state === "running";
  const fraction = jobProgressFraction(job.progress);
  const openFolderPath =
    job.state === "done" ? jobOpenFolderPath(job.kind, job.result?.path) : null;
  const Icon = job.kind === "compress" ? FileArchive : PackageOpen;
  const name = jobDisplayName(job.result?.path, request);

  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-sm text-foreground" title={name}>
            {jobTitle(job.kind, job.state)} · {name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={jobStatusVariant(job.state)}>{jobStateLabel(job.state)}</Badge>
          {job.state === "failed" && request !== undefined && (
            <Button variant="ghost" size="icon-xs" onClick={onRetry} aria-label="Retry job">
              <RotateCcw />
            </Button>
          )}
          {isActive && (
            <Button variant="ghost" size="icon-xs" onClick={onCancel} aria-label="Cancel job">
              <X />
            </Button>
          )}
        </div>
      </div>
      {isActive && <Progress value={fraction === null ? null : fraction * 100} />}
      {isActive && (
        <p className="text-xs text-muted-foreground">
          {formatJobProgress(job.progress, { units: prefs.sizes })}
        </p>
      )}
      {(job.state === "failed" || job.state === "done") && job.error !== undefined && (
        <p
          className={
            job.state === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {job.state === "done" ? `Warning: ${job.error}` : job.error}
        </p>
      )}
      {openFolderPath !== null && (
        <Link
          href={toRoute(pathToHref(openFolderPath))}
          className="text-primary text-xs hover:underline"
        >
          <FolderOpen className="mr-1 inline size-3" aria-hidden="true" />
          Open folder
        </Link>
      )}
    </li>
  );
}

/**
 * Bottom-right floating panel combining the upload queue (`UploadRow`,
 * unchanged from the old dedicated upload panel) with the compress/extract
 * job queue (`JobRow`): per-item progress, state badges, cancel while
 * active, retry for a failed job whose original request is still
 * remembered, and an "Open folder" link once a job is done. Collapses to a
 * compact pill once nothing is left in flight; a single "Clear finished"
 * covers both queues. Renders nothing while both are empty.
 */
export function ActivityPanel() {
  const { prefs } = useFormatters();
  const uploadState = useUploadStore((s) => s.state);
  const retryUpload = useUploadStore((s) => s.retry);
  const cancelUpload = useUploadStore((s) => s.cancel);
  const clearFinishedUploads = useUploadStore((s) => s.clearFinished);

  const jobsState = useJobsStore((s) => s.state);
  const upsertJob = useJobsStore((s) => s.upsert);
  const seedJob = useJobsStore((s) => s.seed);
  const removeJob = useJobsStore((s) => s.remove);

  const isMobile = useIsMobile();
  // On a phone the expanded card would cover the file list, so it starts as the pill
  // and only expands when tapped; desktop keeps the expanded card.
  const [collapsed, setCollapsed] = useState(false);
  const [mobileInitialised, setMobileInitialised] = useState(false);
  useEffect(() => {
    if (isMobile && !mobileInitialised) {
      setCollapsed(true);
      setMobileInitialised(true);
    }
  }, [isMobile, mobileInitialised]);

  const uploadSummary = summarize(uploadState);
  const uploadItems: UploadItem[] = [];
  for (const id of uploadState.order) {
    const item = uploadState.items[id];
    if (item !== undefined) {
      uploadItems.push(item);
    }
  }
  const activeUploads = uploadItems.filter(
    (item) => item.status === "queued" || item.status === "uploading",
  );

  const activeJobList = activeJobs(jobsState);
  const finishedJobList = finishedJobs(jobsState);

  const activeCount = activeUploads.length + activeJobList.length;
  const total = uploadSummary.total + jobsState.order.length;

  const samplesRef = useRef<ThroughputSample[]>([]);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    samplesRef.current = [
      ...samplesRef.current,
      { timestampMs: Date.now(), bytesDone: uploadSummary.bytesDone },
    ].slice(-SAMPLE_HISTORY_LIMIT);
  }, [uploadSummary.bytesDone]);

  useEffect(() => {
    if (wasActiveRef.current && activeCount === 0) {
      setCollapsed(true);
    }
    wasActiveRef.current = activeCount > 0;
  }, [activeCount]);

  // Safety net alongside the `job` SSE stream: while any job is queued or
  // running, periodically refresh it from `apiClient.jobs()` too, in case
  // its own terminal SSE event was dropped, arrived before this session
  // ever subscribed, or the tab's `EventSource` is throttled in the
  // background. `jobsState` (rather than `activeJobList`, a fresh array on
  // every render) is the effect's dependency, so a quiet stretch with no
  // real updates still polls every `JOB_POLL_INTERVAL_MS`.
  useEffect(() => {
    const ids = activeJobs(jobsState).map((j) => j.id);
    if (ids.length === 0) {
      return;
    }
    const interval = setInterval(() => {
      void pollActiveJobs({ jobs: () => apiClient.jobs(), upsertJob }, ids);
    }, JOB_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [jobsState, upsertJob]);

  if (total === 0) {
    return null;
  }

  const jobsFailed = finishedJobList.filter((j) => j.state === "failed").length;
  const jobsDone = finishedJobList.filter((j) => j.state === "done").length;
  const jobsCancelled = finishedJobList.filter((j) => j.state === "cancelled").length;
  const title = activityTitle({
    activeCount,
    uploadsDone: uploadSummary.done,
    uploadsFailed: uploadSummary.failed,
    jobsDone,
    jobsFailed,
    jobsCancelled,
  });

  const speed = estimateSpeed(samplesRef.current);
  const bytesRemaining = Math.max(0, uploadSummary.bytesTotal - uploadSummary.bytesDone);

  function retryDepsFor(): RetryJobDeps {
    return {
      compress: (req) => apiClient.compress(req),
      extract: (req) => apiClient.extract(req),
      seedJob: (job, request) => seedJob(job, request),
      notifySuccess: (message) => toast.success(message),
      notifyError: (message) => toast.error(message),
      getRequest: (id) => jobsState.requests[id],
      notifyMissingRequest: (message) => toast.error(message),
    };
  }

  function handleCancelJob(id: string) {
    void cancelJob(
      {
        cancel: (jobId) => apiClient.cancelJob(jobId),
        upsertJob: (job) => upsertJob(job),
        notifyError: (message) => toast.error(message),
      },
      id,
    );
  }

  function handleRetryJob(id: string) {
    void retryJob(retryDepsFor(), id);
  }

  function handleClearFinished() {
    clearFinishedUploads();
    for (const job of finishedJobList) {
      removeJob(job.id);
    }
  }

  if (collapsed) {
    return (
      <Button
        variant="outline"
        onClick={() => setCollapsed(false)}
        className="fixed right-4 bottom-4 z-50 h-auto rounded-full bg-popover px-4 py-2 text-popover-foreground shadow-sm ring-1 ring-foreground/10"
      >
        <UploadCloud />
        {title}
      </Button>
    );
  }

  const finished = activeCount === 0;

  return (
    <Card
      data-slot="activity-panel"
      className="fixed right-4 bottom-4 z-50 flex max-h-[70vh] w-80 flex-col gap-3 shadow-lg max-md:inset-x-3 max-md:right-3 max-md:w-auto max-md:max-h-[50vh]"
    >
      {/* The card header is a grid by default; `flex` keeps the title and actions on one row. */}
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <div className="flex shrink-0 items-center gap-1">
          {finished && (
            <Button variant="ghost" size="sm" onClick={handleClearFinished}>
              Clear
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse activity panel"
          >
            <ChevronDown />
          </Button>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        {!finished && activeUploads.length > 0 && (
          <div className="flex shrink-0 flex-col gap-1">
            <Progress value={uploadSummary.overallProgress * 100} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{formatSpeed(speed, { units: prefs.sizes })}</span>
              <span>{formatEta(bytesRemaining, speed)} left</span>
            </div>
          </div>
        )}
        <div className="max-h-72 min-h-0 overflow-y-auto" data-slot="activity-panel-list">
          <ul className="divide-y divide-border">
            {uploadItems.map((item) => (
              <UploadRow
                key={item.id}
                item={item}
                onRetry={() => retryUpload(item.id)}
                onCancel={() => cancelUpload(item.id)}
              />
            ))}
            {[...activeJobList, ...finishedJobList].map((j) => (
              <JobRow
                key={j.id}
                job={j}
                request={jobsState.requests[j.id]}
                onCancel={() => handleCancelJob(j.id)}
                onRetry={() => handleRetryJob(j.id)}
              />
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
