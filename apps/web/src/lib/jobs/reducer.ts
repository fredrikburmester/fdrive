import type { JobStatus } from "@fdrive/contracts";
import type { JobRequest } from "./types";

/**
 * The Activity panel's client-side view of every job the current session
 * knows about: jobs loaded from `GET /fs/jobs` on shell mount plus every
 * `job` SSE event received since. `order` is insertion order (oldest
 * first), so the panel can render jobs in the order they were seen without
 * re-sorting on every update. `requests` carries the original request for
 * jobs submitted this session, keyed by job id (see `JobRequest`).
 */
export interface JobsState {
  readonly byId: Readonly<Record<string, JobStatus>>;
  readonly order: readonly string[];
  readonly requests: Readonly<Record<string, JobRequest>>;
}

export const initialJobsState: JobsState = { byId: {}, order: [], requests: {} };

export type JobsAction =
  | { readonly type: "hydrate"; readonly jobs: readonly JobStatus[] }
  | { readonly type: "upsert"; readonly job: JobStatus; readonly request?: JobRequest }
  | { readonly type: "seed"; readonly job: JobStatus; readonly request: JobRequest }
  | { readonly type: "remove"; readonly id: string };

/**
 * Applies `action` to `state`. `hydrate` replaces the whole set (used once,
 * on shell mount, from `apiClient.jobs()`), keeping only the remembered
 * requests whose job id survived. `upsert` adds a job to the end of `order`
 * the first time it is seen and updates it in place afterwards; passing
 * `request` remembers (or overwrites) the request to retry with. `seed`
 * is like `upsert` but never overwrites a job already in `byId`: it exists
 * for the placeholder `runJobRequest` adds right after submitting a job,
 * which can lose a race against that same job's own terminal `job` SSE
 * event (a job can queue, run, and fail in a few milliseconds, all before
 * the submitting `POST` even resolves client-side, since the already-open
 * SSE connection and the response to that `POST` are delivered
 * independently). Without this, the placeholder would silently overwrite
 * the real "failed" status with a stale "queued" one. Its `request` is
 * always remembered, win or lose, so a job that failed before the
 * placeholder ever lands can still be retried. `remove` drops a job and
 * its remembered request, used by "Clear finished".
 */
export function jobsReducer(state: JobsState, action: JobsAction): JobsState {
  switch (action.type) {
    case "hydrate": {
      const byId: Record<string, JobStatus> = {};
      const order: string[] = [];
      const requests: Record<string, JobRequest> = {};
      for (const job of action.jobs) {
        byId[job.id] = job;
        order.push(job.id);
        const existing = state.requests[job.id];
        if (existing !== undefined) {
          requests[job.id] = existing;
        }
      }
      return { byId, order, requests };
    }

    case "upsert": {
      const exists = action.job.id in state.byId;
      const requests =
        action.request !== undefined
          ? { ...state.requests, [action.job.id]: action.request }
          : state.requests;
      return {
        byId: { ...state.byId, [action.job.id]: action.job },
        order: exists ? state.order : [...state.order, action.job.id],
        requests,
      };
    }

    case "seed": {
      const requests = { ...state.requests, [action.job.id]: action.request };
      if (action.job.id in state.byId) {
        return { ...state, requests };
      }
      return {
        byId: { ...state.byId, [action.job.id]: action.job },
        order: [...state.order, action.job.id],
        requests,
      };
    }

    case "remove": {
      if (!(action.id in state.byId)) {
        return state;
      }
      const byId = { ...state.byId };
      delete byId[action.id];
      const requests = { ...state.requests };
      delete requests[action.id];
      return { byId, order: state.order.filter((id) => id !== action.id), requests };
    }
  }
}

function jobsInState(state: JobsState): JobStatus[] {
  const jobs: JobStatus[] = [];
  for (const id of state.order) {
    const job = state.byId[id];
    if (job !== undefined) {
      jobs.push(job);
    }
  }
  return jobs;
}

/** Jobs still in flight, in the order they were first seen. */
export function activeJobs(state: JobsState): JobStatus[] {
  return jobsInState(state).filter((job) => job.state === "queued" || job.state === "running");
}

/** Jobs that have reached a terminal state, in the order they were first seen. */
export function finishedJobs(state: JobsState): JobStatus[] {
  return jobsInState(state).filter((job) => job.state !== "queued" && job.state !== "running");
}
