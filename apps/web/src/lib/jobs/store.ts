import type { JobStatus } from "@fdrive/contracts";
import { create } from "zustand";
import { initialJobsState, type JobsState, jobsReducer } from "./reducer";
import type { JobRequest } from "./types";

export interface JobsStoreState {
  readonly state: JobsState;
  /** Replaces the whole set with the result of `apiClient.jobs()`. */
  hydrate(jobs: readonly JobStatus[]): void;
  /** Adds or updates a job, optionally remembering the request that started it. */
  upsert(job: JobStatus, request?: JobRequest): void;
  /**
   * Adds `job` only if its id is not already known (never overwrites), and
   * always remembers `request`. See `jobsReducer`'s `"seed"` case for why
   * this is not just `upsert`: the placeholder `runJobRequest` seeds right
   * after submitting a job can otherwise lose a race against that same
   * job's own terminal `job` SSE event.
   */
  seed(job: JobStatus, request: JobRequest): void;
  /** Drops a finished job and its remembered request. */
  remove(id: string): void;
}

/**
 * The app-wide job tracking store: every job the current session knows
 * about, fed by `apiClient.jobs()` on shell mount (`hydrate`) and by `job`
 * SSE events afterwards (`upsert`, see `lib/api/sse.ts`). The Activity
 * panel reads it to render job rows alongside uploads.
 */
export const useJobsStore = create<JobsStoreState>((set) => ({
  state: initialJobsState,

  hydrate(jobs) {
    set((s) => ({ state: jobsReducer(s.state, { type: "hydrate", jobs }) }));
  },

  upsert(job, request) {
    set((s) => ({
      state: jobsReducer(
        s.state,
        request === undefined ? { type: "upsert", job } : { type: "upsert", job, request },
      ),
    }));
  },

  seed(job, request) {
    set((s) => ({ state: jobsReducer(s.state, { type: "seed", job, request }) }));
  },

  remove(id) {
    set((s) => ({ state: jobsReducer(s.state, { type: "remove", id }) }));
  },
}));
