/**
 * The counts `activityTitle` needs to summarize the Activity panel's
 * combined upload and job queues into a single headline.
 */
export interface ActivitySummaryInput {
  /** Uploads plus jobs still queued, uploading, or running. */
  readonly activeCount: number;
  readonly uploadsDone: number;
  readonly uploadsFailed: number;
  readonly jobsDone: number;
  readonly jobsFailed: number;
  readonly jobsCancelled?: number;
}

/**
 * The Activity panel's card title and collapsed-pill label: "Working on N
 * item(s)" while anything is in flight, otherwise a summary of what
 * finished ("12 uploaded, 3 finished, 1 failed"), or "All done" when there
 * is nothing to report (everything was cleared, or nothing failed and
 * nothing to count, which should not normally be reachable since the panel
 * itself only renders once something is queued).
 */
export function activityTitle(input: ActivitySummaryInput): string {
  if (input.activeCount > 0) {
    return `Working on ${input.activeCount} item${input.activeCount === 1 ? "" : "s"}`;
  }

  const parts: string[] = [];
  const uploadsFailed = input.uploadsFailed;
  const jobsFailed = input.jobsFailed;
  const totalFailed = uploadsFailed + jobsFailed;

  if (input.uploadsDone > 0 || uploadsFailed > 0) {
    parts.push(`${input.uploadsDone} uploaded`);
  }
  if (input.jobsDone > 0 || jobsFailed > 0) {
    parts.push(`${input.jobsDone} finished`);
  }
  if (input.jobsCancelled) parts.push(`${input.jobsCancelled} cancelled`);
  if (totalFailed > 0) {
    parts.push(`${totalFailed} failed`);
  }

  return parts.length > 0 ? parts.join(", ") : "All done";
}
