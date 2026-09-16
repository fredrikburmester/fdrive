import type { JobKind, JobProgress, JobState } from "@fdrive/contracts";
import { baseName, parentPath } from "@fdrive/core";
import { type FormatBytesOptions, formatBytes } from "../format";
import type { JobRequest } from "./types";

/** A human label for a job's lifecycle state, matching the badge shown per row. */
export function jobStateLabel(state: JobState): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * The job row's headline, combining its kind and state: "Compressing" /
 * "Extracting" while in flight, "Compressed" / "Extracted" once done, and
 * "Compress failed" / "Compress cancelled" (and the extract equivalents)
 * otherwise.
 */
export function jobTitle(kind: JobKind, state: JobState): string {
  const noun = kind === "compress" ? "Compress" : "Extract";
  switch (state) {
    case "queued":
    case "running":
      return kind === "compress" ? "Compressing" : "Extracting";
    case "done":
      return kind === "compress" ? "Compressed" : "Extracted";
    case "failed":
      return `${noun} failed`;
    case "cancelled":
      return `${noun} cancelled`;
  }
}

/** "12 of 40 files" when the total is known, else "12 files". */
export function formatJobFileProgress(progress: JobProgress): string {
  if (progress.total !== null) {
    return `${progress.processed} of ${progress.total} file${progress.total === 1 ? "" : "s"}`;
  }
  return `${progress.processed} file${progress.processed === 1 ? "" : "s"}`;
}

/** "1.2 GB read", from the job's cumulative byte count. */
export function formatJobBytesRead(progress: JobProgress, opts: FormatBytesOptions = {}): string {
  return `${formatBytes(progress.bytes, opts)} read`;
}

/** Combines `formatJobFileProgress` and `formatJobBytesRead` into one line. */
export function formatJobProgress(progress: JobProgress, opts: FormatBytesOptions = {}): string {
  return `${formatJobFileProgress(progress)} · ${formatJobBytesRead(progress, opts)}`;
}

/**
 * The progress bar's value as a 0-1 fraction, or `null` when the total file
 * count is not yet known (an indeterminate bar).
 */
export function jobProgressFraction(progress: JobProgress): number | null {
  if (progress.total === null || progress.total === 0) {
    return null;
  }
  return Math.min(1, progress.processed / progress.total);
}

/**
 * The name shown for a job row: the resulting archive or extracted
 * folder's name once known (`job.result.path`'s base name), else the name
 * implied by the original request (the compress name, or the archive
 * being extracted), else a generic fallback for a job hydrated from
 * `apiClient.jobs()` without a remembered request.
 */
export function jobDisplayName(
  resultPath: string | undefined,
  request: JobRequest | undefined,
): string {
  if (resultPath !== undefined) {
    return baseName(resultPath);
  }
  if (request !== undefined) {
    return request.kind === "compress"
      ? (request.req.name ?? "archive")
      : baseName(request.req.path);
  }
  return "Job";
}

/**
 * The folder a done job's "Open folder" link navigates to: for compress,
 * the folder holding the new archive file (the archive's own parent); for
 * extract, the destination folder itself, since `job.result.path` for an
 * extract job already names a directory of newly-arrived files rather than
 * a single new file. Returns `null` before the job has a result.
 */
export function jobOpenFolderPath(kind: JobKind, resultPath: string | undefined): string | null {
  if (resultPath === undefined) {
    return null;
  }
  return kind === "compress" ? parentPath(resultPath) : resultPath;
}
