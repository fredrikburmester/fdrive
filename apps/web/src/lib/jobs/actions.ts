import type { CompressRequest, ExtractRequest, JobAccepted, JobStatus } from "@fdrive/contracts";
import { describeFsError } from "../files/queries";
import { placeholderJob } from "./placeholder";
import type { JobRequest } from "./types";

/**
 * The dependencies `runJobRequest` needs, injected so it can be tested with
 * fakes instead of mocking the API client, the job store, or the toast
 * library. `now` defaults to the real clock inside `placeholderJob`.
 */
export interface RunJobRequestDeps {
  readonly compress: (req: CompressRequest) => Promise<JobAccepted>;
  readonly extract: (req: ExtractRequest) => Promise<JobAccepted>;
  readonly upsertJob: (job: JobStatus, request?: JobRequest) => void;
  readonly notifySuccess: (message: string) => void;
  readonly notifyError: (message: string) => void;
  readonly now?: () => string;
}

function startedMessage(kind: JobRequest["kind"]): string {
  return kind === "compress" ? "Compressing…" : "Extracting…";
}

function startFailedMessage(kind: JobRequest["kind"]): string {
  return kind === "compress" ? "Could not start compressing." : "Could not start extracting.";
}

/**
 * Submits `request` (a compress or extract job) and, on success, adds a
 * placeholder "queued" job to the store under its new id, remembering the
 * request itself for a future retry. The real `job` SSE event overwrites
 * the placeholder by id once it arrives (see `lib/api/sse.ts`). Failures
 * are reported through `notifyError`, never thrown.
 */
export async function runJobRequest(deps: RunJobRequestDeps, request: JobRequest): Promise<void> {
  try {
    const accepted =
      request.kind === "compress"
        ? await deps.compress(request.req)
        : await deps.extract(request.req);
    deps.upsertJob(placeholderJob(accepted.jobId, request.kind, deps.now), request);
    deps.notifySuccess(startedMessage(request.kind));
  } catch (err) {
    deps.notifyError(describeFsError(err, startFailedMessage(request.kind)));
  }
}

export interface RetryJobDeps extends RunJobRequestDeps {
  /** Looks up the remembered request for a job id, if any. */
  readonly getRequest: (id: string) => JobRequest | undefined;
  /** Called instead of resubmitting when no request was remembered for `id`. */
  readonly notifyMissingRequest: (message: string) => void;
}

/**
 * Resubmits the request that started job `id`, using the same
 * `runJobRequest` path a fresh submission would. Jobs loaded from
 * `apiClient.jobs()` on shell mount (rather than submitted this session)
 * have no remembered request, so retrying them calls `notifyMissingRequest`
 * instead of guessing at one.
 */
export async function retryJob(deps: RetryJobDeps, id: string): Promise<void> {
  const request = deps.getRequest(id);
  if (request === undefined) {
    deps.notifyMissingRequest("Can't retry: the original request is no longer available.");
    return;
  }
  await runJobRequest(deps, request);
}

export interface CancelJobDeps {
  readonly cancel: (id: string) => Promise<JobStatus>;
  readonly upsertJob: (job: JobStatus) => void;
  readonly notifyError: (message: string) => void;
}

/** Cancels job `id` and updates the store with the API's resulting status. */
export async function cancelJob(deps: CancelJobDeps, id: string): Promise<void> {
  try {
    const job = await deps.cancel(id);
    deps.upsertJob(job);
  } catch (err) {
    deps.notifyError(describeFsError(err, "Could not cancel."));
  }
}
