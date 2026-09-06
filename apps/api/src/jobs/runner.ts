import { randomUUID } from "node:crypto";
import type { JobKind, JobState, JobStatus } from "@fdrive/contracts";
import type { EventBus } from "../events/bus.js";
import type { JobProgressPatch, JobRunContext } from "./types.js";

/** Thrown by `submit` when the runner is already holding `maxJobs` jobs in memory. */
export class JobQueueFullError extends Error {
  constructor() {
    super("the job queue is full");
    this.name = "JobQueueFullError";
  }
}

export interface SubmitJobInput {
  readonly identityId: string;
  readonly kind: JobKind;
  readonly run: (ctx: JobRunContext) => Promise<{ path: string; warning?: string }>;
}

export interface JobRunner {
  submit(input: SubmitJobInput): JobStatus;
  get(id: string, identityId: string): JobStatus | null;
  list(identityId: string): JobStatus[];
  /** Aborts the job's signal. Returns its (possibly still-running) status, or `null` if not found for this identity. */
  cancel(id: string, identityId: string): JobStatus | null;
}

export interface JobRunnerDeps {
  readonly clock: () => Date;
  readonly bus: EventBus;
  /** Maximum jobs run concurrently per identity; extra jobs queue. Default 2. */
  readonly concurrencyPerIdentity?: number;
  /** Maximum jobs held in memory (running, queued, or finished) at once. Default 500. */
  readonly maxJobs?: number;
  /** How long a finished job is kept before pruning. Default 1 hour. */
  readonly retentionMs?: number;
  /** Overridable for tests: generates job ids. Defaults to `randomUUID`. */
  readonly idGenerator?: () => string;
}

interface InternalJob {
  readonly id: string;
  readonly identityId: string;
  readonly kind: JobKind;
  readonly createdAt: Date;
  state: JobState;
  updatedAt: Date;
  processed: number;
  total: number | null;
  bytes: number;
  result?: { path: string };
  error?: string;
  readonly controller: AbortController;
  readonly run: (ctx: JobRunContext) => Promise<{ path: string; warning?: string }>;
  lastProgressPublishMs: number;
}

const DEFAULT_CONCURRENCY_PER_IDENTITY = 2;
const DEFAULT_MAX_JOBS = 500;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
/** At most 4 progress-only updates published per job per second. */
const PROGRESS_PUBLISH_INTERVAL_MS = 250;

function toJobStatus(job: InternalJob): JobStatus {
  const status: JobStatus = {
    id: job.id,
    kind: job.kind,
    state: job.state,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    progress: { processed: job.processed, total: job.total, bytes: job.bytes },
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
  return status;
}

/**
 * Builds an in-process job runner for long-running filesystem work
 * (compress, extract): jobs queue per identity (default concurrency 2),
 * report progress and terminal state through `deps.bus` as `JobEvent`s
 * (progress updates throttled to at most 4 per second per job; state
 * transitions are never throttled), and are pruned from memory
 * `retentionMs` (default 1 hour) after they finish. Jobs are in-memory
 * only: a process restart loses them.
 */
export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const clock = deps.clock;
  const bus = deps.bus;
  const concurrencyPerIdentity = deps.concurrencyPerIdentity ?? DEFAULT_CONCURRENCY_PER_IDENTITY;
  const maxJobs = deps.maxJobs ?? DEFAULT_MAX_JOBS;
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
  const idGenerator = deps.idGenerator ?? randomUUID;

  const jobs = new Map<string, InternalJob>();
  /** FIFO queue of jobs waiting to start, per identity. */
  const queues = new Map<string, InternalJob[]>();
  /** Count of jobs currently running (not queued), per identity. */
  const runningCounts = new Map<string, number>();

  function publish(job: InternalJob, opts: { force: boolean }): void {
    const now = clock().getTime();
    if (!opts.force && now - job.lastProgressPublishMs < PROGRESS_PUBLISH_INTERVAL_MS) {
      return;
    }
    job.lastProgressPublishMs = now;
    bus.publish({
      type: "job",
      job: toJobStatus(job),
      at: new Date(now).toISOString(),
      identityId: job.identityId,
    });
  }

  function scheduleRetentionPrune(job: InternalJob): void {
    const timer = setTimeout(() => {
      jobs.delete(job.id);
    }, retentionMs);
    // Never keep the process alive just to prune an in-memory map.
    timer.unref?.();
  }

  /**
   * Marks `job` as finished: runs `update` to set its result or error,
   * transitions to `state`, and publishes the resulting status. When
   * `releaseSlot` is true (the job was actually occupying a running slot),
   * frees that slot and starts the next queued job for the identity, if
   * any.
   */
  function finishJob(
    job: InternalJob,
    state: "done" | "failed" | "cancelled",
    update: () => void,
    releaseSlot: boolean,
  ): void {
    update();
    job.state = state;
    job.updatedAt = clock();
    publish(job, { force: true });
    scheduleRetentionPrune(job);
    if (releaseSlot) {
      const identityCount = runningCounts.get(job.identityId) ?? 0;
      runningCounts.set(job.identityId, Math.max(0, identityCount - 1));
      startNextQueued(job.identityId);
    }
  }

  function startJob(job: InternalJob): void {
    job.state = "running";
    job.updatedAt = clock();
    publish(job, { force: true });

    const report = (patch: JobProgressPatch): void => {
      if (patch.processed !== undefined) {
        job.processed = patch.processed;
      }
      if (patch.total !== undefined) {
        job.total = patch.total;
      }
      if (patch.bytes !== undefined) {
        job.bytes = patch.bytes;
      }
      job.updatedAt = clock();
      publish(job, { force: false });
    };

    job
      .run({ signal: job.controller.signal, report })
      .then((outcome) => {
        finishJob(
          job,
          "done",
          () => {
            job.result = { path: outcome.path };
            if (outcome.warning !== undefined) {
              job.error = outcome.warning;
            }
          },
          true,
        );
      })
      .catch((error: unknown) => {
        const cancelled = job.controller.signal.aborted;
        finishJob(
          job,
          cancelled ? "cancelled" : "failed",
          () => {
            if (!cancelled) {
              job.error = error instanceof Error ? error.message : String(error);
            }
          },
          true,
        );
      });
  }

  function startNextQueued(identityId: string): void {
    const running = runningCounts.get(identityId) ?? 0;
    if (running >= concurrencyPerIdentity) {
      return;
    }
    const queue = queues.get(identityId);
    const job = queue?.shift();
    if (job === undefined) {
      return;
    }
    runningCounts.set(identityId, running + 1);
    startJob(job);
  }

  function pruneIfOverCapacity(): void {
    if (jobs.size < maxJobs) {
      return;
    }
    for (const [id, job] of jobs) {
      if (job.state === "done" || job.state === "failed" || job.state === "cancelled") {
        jobs.delete(id);
        if (jobs.size < maxJobs) {
          return;
        }
      }
    }
  }

  return {
    submit(input: SubmitJobInput): JobStatus {
      pruneIfOverCapacity();
      if (jobs.size >= maxJobs) {
        throw new JobQueueFullError();
      }

      const now = clock();
      const job: InternalJob = {
        id: idGenerator(),
        identityId: input.identityId,
        kind: input.kind,
        createdAt: now,
        updatedAt: now,
        state: "queued",
        processed: 0,
        total: null,
        bytes: 0,
        controller: new AbortController(),
        run: input.run,
        lastProgressPublishMs: 0,
      };
      jobs.set(job.id, job);

      const queue = queues.get(job.identityId) ?? [];
      queue.push(job);
      queues.set(job.identityId, queue);
      publish(job, { force: true });

      startNextQueued(job.identityId);
      return toJobStatus(job);
    },

    get(id: string, identityId: string): JobStatus | null {
      const job = jobs.get(id);
      return job !== undefined && job.identityId === identityId ? toJobStatus(job) : null;
    },

    list(identityId: string): JobStatus[] {
      const result: JobStatus[] = [];
      for (const job of jobs.values()) {
        if (job.identityId === identityId) {
          result.push(toJobStatus(job));
        }
      }
      return result;
    },

    cancel(id: string, identityId: string): JobStatus | null {
      const job = jobs.get(id);
      if (job === undefined || job.identityId !== identityId) {
        return null;
      }
      if (job.state === "done" || job.state === "failed" || job.state === "cancelled") {
        return toJobStatus(job);
      }

      const wasQueued = job.state === "queued";
      job.controller.abort();

      if (wasQueued) {
        const queue = queues.get(job.identityId);
        if (queue !== undefined) {
          const index = queue.indexOf(job);
          if (index !== -1) {
            queue.splice(index, 1);
          }
        }
        // A queued job never occupied a running slot, so its cancellation
        // does not free one (and there is nothing new to start).
        finishJob(job, "cancelled", () => {}, false);
      }

      return toJobStatus(job);
    },
  };
}
