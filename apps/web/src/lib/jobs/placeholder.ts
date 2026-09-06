import type { JobKind, JobStatus } from "@fdrive/contracts";

/**
 * Builds a synthetic "just submitted" `JobStatus` for `id`, shown in the
 * Activity panel the instant `compress`/`extract` accepts a request (202),
 * before the first `job` SSE event for it arrives. The real event
 * overwrites this by id once it arrives (see `JobsStore.upsert`), so a
 * stale placeholder never lingers.
 */
export function placeholderJob(
  id: string,
  kind: JobKind,
  now: () => string = () => new Date().toISOString(),
): JobStatus {
  const at = now();
  return {
    id,
    kind,
    state: "queued",
    createdAt: at,
    updatedAt: at,
    progress: { processed: 0, total: null, bytes: 0 },
  };
}
