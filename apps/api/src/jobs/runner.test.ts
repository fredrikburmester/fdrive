import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusEvent } from "../events/bus.js";
import { createEventBus } from "../events/bus.js";
import { createJobRunner, JOB_AUTHORITY_REVOKED_MESSAGE, JobQueueFullError } from "./runner.js";
import type { JobRunContext } from "./types.js";

const IDENTITY_A = "identity-a";
const IDENTITY_B = "identity-b";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function collectJobEvents(bus: ReturnType<typeof createEventBus>, identityId: string): BusEvent[] {
  const events: BusEvent[] = [];
  bus.subscribe({ identityId }, (event) => events.push(event));
  return events;
}

/**
 * Drains the microtask queue a few times over, enough for a chain of
 * `.then()`/`.catch()` continuations (as the runner uses to settle a job) to
 * finish running. Deliberately avoids `vi.waitFor`, which does not mix well
 * with fake timers here: the runner's own state transitions resolve purely
 * through microtasks, never through a timer.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("createJobRunner", () => {
  let now: Date;
  const clock = () => now;

  beforeEach(() => {
    now = new Date("2024-01-01T00:00:00.000Z");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a job immediately when under the concurrency limit and publishes 'running'", async () => {
    const bus = createEventBus();
    const events = collectJobEvents(bus, IDENTITY_A);
    const runner = createJobRunner({ clock, bus });
    const work = deferred<{ path: string }>();

    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => work.promise,
    });

    expect(status.state).toBe("running");
    expect(status.kind).toBe("compress");
    expect(status.progress).toEqual({ processed: 0, total: null, bytes: 0 });
    expect(events.map((e) => (e.type === "job" ? e.job.state : e.type))).toEqual([
      "queued",
      "running",
    ]);

    work.resolve({ path: "/out.zip" });
    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("done");
    const final = runner.get(status.id, IDENTITY_A);
    expect(final?.result).toEqual({ path: "/out.zip" });
  });

  it("fails a job whose authority check no longer holds when it starts, without running it", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus, concurrencyPerIdentity: 1 });
    const first = deferred<{ path: string }>();
    const run = vi.fn(async () => ({ path: "/never.zip" }));
    let authorized = true;

    runner.submit({ identityId: IDENTITY_A, kind: "compress", run: () => first.promise });
    const queued = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      authorize: async () => authorized,
      run,
    });
    expect(queued.state).toBe("queued");

    // The session that queued the second job ends before it leaves the queue.
    authorized = false;
    first.resolve({ path: "/a.zip" });
    await flush();

    const final = runner.get(queued.id, IDENTITY_A);
    expect(final?.state).toBe("failed");
    expect(final?.error).toBe(JOB_AUTHORITY_REVOKED_MESSAGE);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a job whose authority check still holds when it starts", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus });

    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      authorize: async () => true,
      run: async () => ({ path: "/ok.zip" }),
    });
    await flush();

    expect(runner.get(status.id, IDENTITY_A)).toMatchObject({
      state: "done",
      result: { path: "/ok.zip" },
    });
  });

  it("queues jobs beyond the per-identity concurrency limit and starts the next one when a slot frees", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus, concurrencyPerIdentity: 2 });
    const first = deferred<{ path: string }>();
    const second = deferred<{ path: string }>();
    const third = deferred<{ path: string }>();

    const s1 = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => first.promise,
    });
    const s2 = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => second.promise,
    });
    const s3 = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => third.promise,
    });

    expect(s1.state).toBe("running");
    expect(s2.state).toBe("running");
    expect(s3.state).toBe("queued");

    first.resolve({ path: "/a.zip" });
    await flush();
    expect(runner.get(s3.id, IDENTITY_A)?.state).toBe("running");

    second.resolve({ path: "/b.zip" });
    third.resolve({ path: "/c.zip" });
    await flush();
    expect(runner.get(s3.id, IDENTITY_A)?.state).toBe("done");
  });

  it("tracks concurrency per identity independently", () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus, concurrencyPerIdentity: 1 });
    const a1 = deferred<{ path: string }>();
    const b1 = deferred<{ path: string }>();

    const sa = runner.submit({ identityId: IDENTITY_A, kind: "compress", run: () => a1.promise });
    const sb = runner.submit({ identityId: IDENTITY_B, kind: "compress", run: () => b1.promise });

    expect(sa.state).toBe("running");
    expect(sb.state).toBe("running");
  });

  it("reports a failure's message and state on rejection", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus });
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "extract",
      run: async () => {
        throw new Error("boom");
      },
    });

    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("failed");
    const final = runner.get(status.id, IDENTITY_A);
    expect(final?.error).toBe("boom");
    expect(final?.result).toBeUndefined();
  });

  it("stringifies a non-Error rejection", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus });
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "extract",
      run: async () => {
        throw "plain string failure";
      },
    });

    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("failed");
    expect(runner.get(status.id, IDENTITY_A)?.error).toBe("plain string failure");
  });

  it("stores a warning as job.error while state stays done", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus });
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "extract",
      run: async () => ({ path: "/out", warning: "skipped 1 entry" }),
    });

    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("done");
    const final = runner.get(status.id, IDENTITY_A);
    expect(final?.error).toBe("skipped 1 entry");
    expect(final?.result).toEqual({ path: "/out" });
  });

  it("merges partial progress patches and reports through get()", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus });
    const work = deferred<{ path: string }>();
    let ctx!: JobRunContext;

    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: (runCtx) => {
        ctx = runCtx;
        return work.promise;
      },
    });

    ctx.report({ total: 10 });
    expect(runner.get(status.id, IDENTITY_A)?.progress).toEqual({
      processed: 0,
      total: 10,
      bytes: 0,
    });

    ctx.report({ processed: 3, bytes: 100 });
    expect(runner.get(status.id, IDENTITY_A)?.progress).toEqual({
      processed: 3,
      total: 10,
      bytes: 100,
    });

    work.resolve({ path: "/out.zip" });
    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("done");
  });

  it("throttles progress-only publishes to at most one per 250ms, but never throttles state transitions", async () => {
    const bus = createEventBus();
    const events = collectJobEvents(bus, IDENTITY_A);
    const runner = createJobRunner({ clock, bus });
    const work = deferred<{ path: string }>();
    let ctx!: JobRunContext;

    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: (runCtx) => {
        ctx = runCtx;
        return work.promise;
      },
    });
    // queued + running so far
    expect(events).toHaveLength(2);

    ctx.report({ processed: 1 });
    ctx.report({ processed: 2 });
    ctx.report({ processed: 3 });
    // All three progress reports happened at the same instant (< 250ms since
    // "running" was published), so only state transitions have published so
    // far: still 2 events.
    expect(events).toHaveLength(2);

    now = new Date(now.getTime() + 300);
    ctx.report({ processed: 4 });
    expect(events).toHaveLength(3);
    const progressEvent = events[2];
    expect(progressEvent?.type === "job" && progressEvent.job.progress.processed).toBe(4);

    work.resolve({ path: "/out.zip" });
    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("done");
  });

  it("cancels a running job: the signal is aborted and the job becomes cancelled once run() observes it", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus });
    let sawAbort = false;
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: (ctx) => {
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          });
        });
      },
    });

    const cancelled = runner.cancel(status.id, IDENTITY_A);
    expect(cancelled?.state).toBe("running");
    expect(sawAbort).toBe(true);

    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("cancelled");
    expect(runner.get(status.id, IDENTITY_A)?.error).toBeUndefined();
  });

  it("cancels a queued job immediately without starting it, freeing no running slot", () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus, concurrencyPerIdentity: 1 });
    const first = deferred<{ path: string }>();
    let secondStarted = false;

    const s1 = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => first.promise,
    });
    const s2 = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: async () => {
        secondStarted = true;
        return { path: "/b.zip" };
      },
    });

    expect(s1.state).toBe("running");
    expect(s2.state).toBe("queued");

    const cancelled = runner.cancel(s2.id, IDENTITY_A);
    expect(cancelled?.state).toBe("cancelled");
    expect(secondStarted).toBe(false);
    expect(runner.list(IDENTITY_A).find((j) => j.id === s2.id)?.state).toBe("cancelled");
  });

  it("returns null when cancelling an unknown job", () => {
    const runner = createJobRunner({ clock, bus: createEventBus() });
    expect(runner.cancel("nope", IDENTITY_A)).toBeNull();
  });

  it("returns null when cancelling another identity's job", () => {
    const runner = createJobRunner({ clock, bus: createEventBus() });
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => new Promise(() => {}),
    });
    expect(runner.cancel(status.id, IDENTITY_B)).toBeNull();
  });

  it("returns null from get() for another identity's job", () => {
    const runner = createJobRunner({ clock, bus: createEventBus() });
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => new Promise(() => {}),
    });
    expect(runner.get(status.id, IDENTITY_B)).toBeNull();
  });

  it("is a no-op to cancel an already-finished job, returning its status", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus });
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: async () => ({ path: "/out.zip" }),
    });

    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("done");

    const cancelled = runner.cancel(status.id, IDENTITY_A);
    expect(cancelled?.state).toBe("done");
  });

  it("lists only the jobs belonging to the given identity", () => {
    const runner = createJobRunner({ clock, bus: createEventBus() });
    runner.submit({ identityId: IDENTITY_A, kind: "compress", run: () => new Promise(() => {}) });
    runner.submit({ identityId: IDENTITY_B, kind: "extract", run: () => new Promise(() => {}) });

    expect(runner.list(IDENTITY_A)).toHaveLength(1);
    expect(runner.list(IDENTITY_B)).toHaveLength(1);
    expect(runner.list("someone-else")).toHaveLength(0);
  });

  it("prunes a finished job from memory after the retention window", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus, retentionMs: 1000 });
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: async () => ({ path: "/out.zip" }),
    });

    await flush();
    expect(runner.get(status.id, IDENTITY_A)?.state).toBe("done");

    vi.advanceTimersByTime(999);
    expect(runner.get(status.id, IDENTITY_A)).not.toBeNull();

    vi.advanceTimersByTime(2);
    expect(runner.get(status.id, IDENTITY_A)).toBeNull();
  });

  it("still releases a finished job whose outcome could not be written", async () => {
    const bus = createEventBus();
    const events = collectJobEvents(bus, IDENTITY_A);
    const runner = createJobRunner({ clock, bus, maxJobs: 1 });
    const first = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      onOutcome: async () => {
        throw new Error("history offline");
      },
      run: async () => ({ path: "/a.zip" }),
    });

    await flush();
    expect(runner.get(first.id, IDENTITY_A)?.state).toBe("done");

    // An outcome nobody could record leaves the intent open in history, never a
    // job pinned in memory: the slot is still reusable and still prunable.
    const second = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => new Promise(() => {}),
    });
    expect(second.state).toBe("running");
    expect(runner.get(first.id, IDENTITY_A)).toBeNull();
    expect(events.some((event) => event.type === "job" && event.job.state === "done")).toBe(true);
  });

  it("uses a custom id generator when given", () => {
    const runner = createJobRunner({
      clock,
      bus: createEventBus(),
      idGenerator: () => "fixed-id",
    });
    const status = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => new Promise(() => {}),
    });
    expect(status.id).toBe("fixed-id");
  });

  it("throws JobQueueFullError when at capacity with nothing prunable", () => {
    const runner = createJobRunner({ clock, bus: createEventBus(), maxJobs: 1 });
    runner.submit({ identityId: IDENTITY_A, kind: "compress", run: () => new Promise(() => {}) });

    expect(() =>
      runner.submit({
        identityId: IDENTITY_A,
        kind: "compress",
        run: () => new Promise(() => {}),
      }),
    ).toThrow(JobQueueFullError);
  });

  it("prunes finished jobs to make room before rejecting a new submission", async () => {
    const bus = createEventBus();
    const runner = createJobRunner({ clock, bus, maxJobs: 1 });
    const first = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: async () => ({ path: "/a.zip" }),
    });

    await flush();
    expect(runner.get(first.id, IDENTITY_A)?.state).toBe("done");

    const second = runner.submit({
      identityId: IDENTITY_A,
      kind: "compress",
      run: () => new Promise(() => {}),
    });
    expect(second.state).toBe("running");
    expect(runner.get(first.id, IDENTITY_A)).toBeNull();
  });
});

describe("JobQueueFullError", () => {
  it("has a descriptive message and name", () => {
    const error = new JobQueueFullError();
    expect(error.name).toBe("JobQueueFullError");
    expect(error.message.length).toBeGreaterThan(0);
  });
});
