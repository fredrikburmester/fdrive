/**
 * A partial progress update: only the fields present are merged onto a
 * job's current progress. Shared by the job runner and the archive
 * functions it drives.
 */
export type JobProgressPatch = Partial<{
  processed: number;
  total: number | null;
  bytes: number;
}>;

export type ReportProgress = (patch: JobProgressPatch) => void;

/** What a job's `run` function receives: a cancellation signal and a progress reporter. */
export interface JobRunContext {
  readonly signal: AbortSignal;
  readonly report: ReportProgress;
}
