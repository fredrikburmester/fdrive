import type { JobStatus } from "@fdrive/contracts";

/**
 * Filters a fresh `apiClient.jobs()` snapshot down to the jobs in
 * `activeIds` (typically every job the store currently considers queued or
 * running). Used by `pollActiveJobs`'s polling safety net: refreshing only
 * jobs the caller already knows about, never introducing a job the caller
 * has not seen (for example one already dismissed with "Clear finished"),
 * even though `apiClient.jobs()` itself returns every job for the
 * identity, not just the active ones.
 */
export function jobsToRefresh(
  activeIds: readonly string[],
  fetched: readonly JobStatus[],
): JobStatus[] {
  if (activeIds.length === 0) {
    return [];
  }
  const ids = new Set(activeIds);
  return fetched.filter((job) => ids.has(job.id));
}

export interface PollActiveJobsDeps {
  readonly jobs: () => Promise<JobStatus[]>;
  readonly upsertJob: (job: JobStatus) => void;
}

/**
 * Refreshes every job in `activeIds` from `apiClient.jobs()` and applies
 * each one found back into the store with `upsertJob`. A safety net for
 * the Activity panel: normally a `job` SSE event alone keeps a job's
 * displayed state current, but a job that reaches a terminal state before
 * its own placeholder is even seeded (see `jobsReducer`'s `"seed"` case), a
 * dropped SSE message, or a backgrounded tab throttling its `EventSource`
 * could otherwise leave a job looking "Queued" or "Running" indefinitely.
 * A no-op when `activeIds` is empty. Errors are swallowed: a failed poll
 * simply tries again on the next tick.
 */
export async function pollActiveJobs(
  deps: PollActiveJobsDeps,
  activeIds: readonly string[],
): Promise<void> {
  if (activeIds.length === 0) {
    return;
  }
  try {
    const fetched = await deps.jobs();
    for (const job of jobsToRefresh(activeIds, fetched)) {
      deps.upsertJob(job);
    }
  } catch {
    // Swallowed: the next tick (or the SSE stream) will retry or catch up.
  }
}
