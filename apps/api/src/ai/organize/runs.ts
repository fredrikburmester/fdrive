import { randomUUID } from "node:crypto";
import type { OrganizeProposal, OrganizeRun, OrganizeRunState } from "@fdrive/contracts";

/** Thrown by `start` when the identity already has `maxRunningPerIdentity` runs in progress, or memory is full. */
export class OrganizeBusyError extends Error {
  constructor() {
    super("An organize request is already running. Wait for it to finish.");
    this.name = "OrganizeBusyError";
  }
}

/** A failure whose message is written for the person who asked, not for logs. */
export class OrganizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizeError";
  }
}

export interface OrganizeWorkContext {
  readonly signal: AbortSignal;
  /** Appends one short, human-readable step to the run's activity. */
  readonly activity: (text: string) => void;
}

export interface OrganizeRuns {
  start(
    identityId: string,
    itemCount: number,
    work: (ctx: OrganizeWorkContext) => Promise<OrganizeProposal>,
  ): OrganizeRun;
  get(id: string, identityId: string): OrganizeRun | null;
  /** Aborts a running run. Returns its status, or `null` when it is not this identity's. */
  cancel(id: string, identityId: string): OrganizeRun | null;
}

export interface OrganizeRunsOptions {
  readonly clock: () => Date;
  /** Default 1. */
  readonly maxRunningPerIdentity?: number;
  /** Runs kept in memory at once, running or finished. Default 200. */
  readonly maxRuns?: number;
  /** How long a finished run stays readable. Default 1 hour. */
  readonly retentionMs?: number;
  readonly idGenerator?: () => string;
  /** Called with failures that are not `OrganizeError`s, whose messages stay out of the response. */
  readonly onUnexpectedError?: (error: unknown) => void;
}

interface InternalRun {
  readonly id: string;
  readonly identityId: string;
  readonly createdAt: Date;
  readonly itemCount: number;
  readonly controller: AbortController;
  state: OrganizeRunState;
  updatedAt: Date;
  activity: string[];
  proposal?: OrganizeProposal;
  error?: string;
}

const MAX_ACTIVITY = 50;
const UNEXPECTED_ERROR = "Something went wrong while organizing. Try again.";

function toStatus(run: InternalRun): OrganizeRun {
  return {
    id: run.id,
    state: run.state,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    itemCount: run.itemCount,
    activity: [...run.activity],
    ...(run.proposal !== undefined ? { proposal: run.proposal } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

/**
 * In-process organize runs. Like the job runner they are lost on restart,
 * which is harmless: a run only ever produces suggestions and nothing is
 * moved until the person applies them.
 */
export function createOrganizeRuns(options: OrganizeRunsOptions): OrganizeRuns {
  const clock = options.clock;
  const maxRunning = options.maxRunningPerIdentity ?? 1;
  const maxRuns = options.maxRuns ?? 200;
  const retentionMs = options.retentionMs ?? 60 * 60 * 1000;
  const idGenerator = options.idGenerator ?? randomUUID;
  const runs = new Map<string, InternalRun>();

  function prune(): void {
    for (const [id, run] of runs) {
      if (runs.size < maxRuns) return;
      if (run.state !== "running") runs.delete(id);
    }
  }

  function finish(run: InternalRun, state: Exclude<OrganizeRunState, "running">): void {
    run.state = state;
    run.updatedAt = clock();
    const timer = setTimeout(() => runs.delete(run.id), retentionMs);
    timer.unref?.();
  }

  return {
    start(identityId, itemCount, work) {
      const running = [...runs.values()].filter(
        (run) => run.identityId === identityId && run.state === "running",
      ).length;
      if (running >= maxRunning) throw new OrganizeBusyError();
      prune();
      if (runs.size >= maxRuns) throw new OrganizeBusyError();

      const now = clock();
      const run: InternalRun = {
        id: idGenerator(),
        identityId,
        createdAt: now,
        updatedAt: now,
        itemCount,
        controller: new AbortController(),
        state: "running",
        activity: [],
      };
      runs.set(run.id, run);

      const ctx: OrganizeWorkContext = {
        signal: run.controller.signal,
        activity: (text) => {
          if (run.state !== "running") return;
          run.activity = [...run.activity, text].slice(-MAX_ACTIVITY);
          run.updatedAt = clock();
        },
      };
      void Promise.resolve()
        .then(() => work(ctx))
        .then(
          (proposal) => {
            if (run.state !== "running") return;
            run.proposal = proposal;
            finish(run, "done");
          },
          (error: unknown) => {
            if (run.state !== "running") return;
            if (!(error instanceof OrganizeError) && !run.controller.signal.aborted)
              options.onUnexpectedError?.(error);
            run.error = error instanceof OrganizeError ? error.message : UNEXPECTED_ERROR;
            finish(run, "failed");
          },
        );
      return toStatus(run);
    },

    get(id, identityId) {
      const run = runs.get(id);
      return run !== undefined && run.identityId === identityId ? toStatus(run) : null;
    },

    cancel(id, identityId) {
      const run = runs.get(id);
      if (run === undefined || run.identityId !== identityId) return null;
      if (run.state === "running") {
        run.controller.abort();
        finish(run, "cancelled");
      }
      return toStatus(run);
    },
  };
}
