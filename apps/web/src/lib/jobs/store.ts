import type { JobStatus } from "@fdrive/contracts";
import { create } from "zustand";
import { initialJobsState, type JobsState, jobsReducer } from "./reducer";
import type { JobRequest } from "./types";

export interface JobsStoreState {
  readonly state: JobsState;
  reset(): void;
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
/** Old callbacks are invalid after reset, including in-flight poll completions. */
export function createJobsStore() {
  let generation = 0;
  return create<JobsStoreState>((set) => {
    function handlers(epoch: number): Omit<JobsStoreState, "state" | "reset"> {
      function dispatch(action: Parameters<typeof jobsReducer>[1]) {
        if (epoch === generation) set((s) => ({ state: jobsReducer(s.state, action) }));
      }
      return {
        hydrate: (jobs) => dispatch({ type: "hydrate", jobs }),
        upsert: (job, request) =>
          dispatch(
            request === undefined ? { type: "upsert", job } : { type: "upsert", job, request },
          ),
        seed: (job, request) => dispatch({ type: "seed", job, request }),
        remove: (id) => dispatch({ type: "remove", id }),
      };
    }
    return {
      state: initialJobsState,
      ...handlers(generation),
      reset() {
        generation += 1;
        set({ state: initialJobsState, ...handlers(generation) });
      },
    };
  });
}

export const useJobsStore = createJobsStore();
