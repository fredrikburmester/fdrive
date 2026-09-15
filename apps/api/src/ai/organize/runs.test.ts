import type { OrganizeProposal } from "@fdrive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrganizeRuns,
  OrganizeBusyError,
  OrganizeError,
  type OrganizeRunsOptions,
  type OrganizeWorkContext,
} from "./runs.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:01:00.000Z");

const PROPOSAL: OrganizeProposal = { summary: "Plan", suggestions: [], unchanged: [] };

/** Lets the runner's promise chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A controllable piece of work that also captures the context the runner hands it. */
function controllableWork() {
  const result = deferred<OrganizeProposal>();
  const captured: { ctx?: OrganizeWorkContext } = {};
  const work = vi.fn(async (ctx: OrganizeWorkContext) => {
    captured.ctx = ctx;
    return result.promise;
  });
  return {
    work,
    result,
    ctx(): OrganizeWorkContext {
      if (captured.ctx === undefined) throw new Error("work has not started");
      return captured.ctx;
    },
  };
}

function setup(options: Partial<OrganizeRunsOptions> = {}) {
  let now = T0;
  let counter = 0;
  const runs = createOrganizeRuns({
    clock: () => now,
    idGenerator: () => `run-${++counter}`,
    ...options,
  });
  return {
    runs,
    setNow(date: Date) {
      now = date;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createOrganizeRuns", () => {
  it("starts a run in the running state with no proposal or error", async () => {
    const { runs } = setup();
    const { work } = controllableWork();

    const run = runs.start("identity-1", 3, work);

    expect(run).toEqual({
      id: "run-1",
      state: "running",
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
      itemCount: 3,
      activity: [],
    });
    expect(run).not.toHaveProperty("proposal");
    expect(run).not.toHaveProperty("error");
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("marks the run done with the proposal when the work resolves", async () => {
    const { runs, setNow } = setup();
    const { work, result } = controllableWork();
    runs.start("identity-1", 1, work);
    await flush();

    setNow(T1);
    result.resolve(PROPOSAL);
    await flush();

    const run = runs.get("run-1", "identity-1");
    expect(run?.state).toBe("done");
    expect(run?.proposal).toEqual(PROPOSAL);
    expect(run?.createdAt).toBe(T0.toISOString());
    expect(run?.updatedAt).toBe(T1.toISOString());
    expect(run).not.toHaveProperty("error");
  });

  it("fails with the OrganizeError's own message without reporting it as unexpected", async () => {
    const onUnexpectedError = vi.fn();
    const { runs } = setup({ onUnexpectedError });
    const { work, result } = controllableWork();
    runs.start("identity-1", 1, work);

    result.reject(new OrganizeError("None of the selected items exist anymore."));
    await flush();

    const run = runs.get("run-1", "identity-1");
    expect(run?.state).toBe("failed");
    expect(run?.error).toBe("None of the selected items exist anymore.");
    expect(run).not.toHaveProperty("proposal");
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("fails with a generic message and reports any other error", async () => {
    const onUnexpectedError = vi.fn();
    const { runs } = setup({ onUnexpectedError });
    const failure = new Error("database password is hunter2");
    const { work, result } = controllableWork();
    runs.start("identity-1", 1, work);

    result.reject(failure);
    await flush();

    const run = runs.get("run-1", "identity-1");
    expect(run?.state).toBe("failed");
    expect(run?.error).toBe("Something went wrong while organizing. Try again.");
    expect(onUnexpectedError).toHaveBeenCalledWith(failure);
  });

  it("catches work that throws synchronously", async () => {
    const { runs } = setup();
    runs.start("identity-1", 1, () => {
      throw new OrganizeError("Nope.");
    });
    await flush();

    expect(runs.get("run-1", "identity-1")).toMatchObject({ state: "failed", error: "Nope." });
  });

  it("appends activity while running and bumps updatedAt", async () => {
    const { runs, setNow } = setup();
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    await flush();

    setNow(T1);
    control.ctx().activity("Looked through /");
    control.ctx().activity("Opened /Finance");

    const run = runs.get("run-1", "identity-1");
    expect(run?.activity).toEqual(["Looked through /", "Opened /Finance"]);
    expect(run?.updatedAt).toBe(T1.toISOString());
  });

  it("keeps only the 50 most recent activity steps", async () => {
    const { runs } = setup();
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    await flush();

    for (let i = 1; i <= 55; i++) control.ctx().activity(`step ${i}`);

    const activity = runs.get("run-1", "identity-1")?.activity ?? [];
    expect(activity).toHaveLength(50);
    expect(activity[0]).toBe("step 6");
    expect(activity.at(-1)).toBe("step 55");
  });

  it("returns a copy of the activity so callers cannot change the run", async () => {
    const { runs } = setup();
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    await flush();
    control.ctx().activity("one");

    runs.get("run-1", "identity-1")?.activity.push("tampered");

    expect(runs.get("run-1", "identity-1")?.activity).toEqual(["one"]);
  });

  it("ignores activity after the run has finished", async () => {
    const { runs, setNow } = setup();
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    await flush();
    control.ctx().activity("before");
    control.result.resolve(PROPOSAL);
    await flush();

    setNow(T1);
    control.ctx().activity("after");

    const run = runs.get("run-1", "identity-1");
    expect(run?.activity).toEqual(["before"]);
    expect(run?.updatedAt).toBe(T0.toISOString());
  });

  it("returns null from get and cancel for another identity's run", async () => {
    const { runs } = setup();
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    await flush();

    expect(runs.get("run-1", "identity-2")).toBeNull();
    expect(runs.cancel("run-1", "identity-2")).toBeNull();
    expect(control.ctx().signal.aborted).toBe(false);
    expect(runs.get("run-1", "identity-1")?.state).toBe("running");
  });

  it("returns null from get and cancel for an unknown run", () => {
    const { runs } = setup();

    expect(runs.get("missing", "identity-1")).toBeNull();
    expect(runs.cancel("missing", "identity-1")).toBeNull();
  });

  it("cancels a running run: aborts its signal and keeps a later resolution from overwriting it", async () => {
    const { runs, setNow } = setup();
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    await flush();

    setNow(T1);
    const cancelled = runs.cancel("run-1", "identity-1");

    expect(cancelled).toMatchObject({ state: "cancelled", updatedAt: T1.toISOString() });
    expect(control.ctx().signal.aborted).toBe(true);

    control.result.resolve(PROPOSAL);
    await flush();
    const run = runs.get("run-1", "identity-1");
    expect(run?.state).toBe("cancelled");
    expect(run).not.toHaveProperty("proposal");
  });

  it("keeps a cancelled run cancelled when its work then rejects, without reporting the error", async () => {
    const onUnexpectedError = vi.fn();
    const { runs } = setup({ onUnexpectedError });
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    await flush();

    runs.cancel("run-1", "identity-1");
    control.result.reject(new DOMException("The operation was aborted.", "AbortError"));
    await flush();

    const run = runs.get("run-1", "identity-1");
    expect(run?.state).toBe("cancelled");
    expect(run).not.toHaveProperty("error");
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("returns a finished run unchanged from cancel", async () => {
    const { runs, setNow } = setup();
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    control.result.resolve(PROPOSAL);
    await flush();

    setNow(T1);
    const run = runs.cancel("run-1", "identity-1");

    expect(run).toMatchObject({ state: "done", updatedAt: T0.toISOString(), proposal: PROPOSAL });
    expect(control.ctx().signal.aborted).toBe(false);
  });

  it("refuses a second running run for the same identity but not for another identity", async () => {
    const { runs } = setup();
    const first = controllableWork();
    runs.start("identity-1", 1, first.work);

    expect(() => runs.start("identity-1", 1, controllableWork().work)).toThrow(OrganizeBusyError);
    expect(() => runs.start("identity-1", 1, controllableWork().work)).toThrow(
      "An organize request is already running. Wait for it to finish.",
    );
    expect(runs.start("identity-2", 1, controllableWork().work).state).toBe("running");

    first.result.resolve(PROPOSAL);
    await flush();
    expect(runs.start("identity-1", 1, controllableWork().work).state).toBe("running");
  });

  it("allows as many running runs per identity as configured", () => {
    const { runs } = setup({ maxRunningPerIdentity: 2 });

    runs.start("identity-1", 1, controllableWork().work);
    runs.start("identity-1", 1, controllableWork().work);

    expect(() => runs.start("identity-1", 1, controllableWork().work)).toThrow(OrganizeBusyError);
  });

  it("drops the oldest finished runs to make room once maxRuns is reached", async () => {
    const { runs } = setup({ maxRuns: 2 });
    const finished = controllableWork();
    runs.start("identity-1", 1, finished.work);
    finished.result.resolve(PROPOSAL);
    await flush();
    runs.start("identity-2", 1, controllableWork().work);

    const third = runs.start("identity-3", 1, controllableWork().work);

    expect(third.id).toBe("run-3");
    expect(runs.get("run-1", "identity-1")).toBeNull();
    expect(runs.get("run-2", "identity-2")?.state).toBe("running");
    expect(runs.get("run-3", "identity-3")?.state).toBe("running");
  });

  it("refuses a new run when maxRuns runs are all still running", () => {
    const { runs } = setup({ maxRuns: 2 });
    runs.start("identity-1", 1, controllableWork().work);
    runs.start("identity-2", 1, controllableWork().work);

    expect(() => runs.start("identity-3", 1, controllableWork().work)).toThrow(OrganizeBusyError);
    expect(runs.get("run-1", "identity-1")?.state).toBe("running");
    expect(runs.get("run-2", "identity-2")?.state).toBe("running");
  });

  it("forgets a finished run once the retention period passes", async () => {
    vi.useFakeTimers();
    const { runs } = setup({ retentionMs: 1000 });
    const control = controllableWork();
    runs.start("identity-1", 1, control.work);
    control.result.resolve(PROPOSAL);
    await flush();

    vi.advanceTimersByTime(999);
    expect(runs.get("run-1", "identity-1")?.state).toBe("done");

    vi.advanceTimersByTime(1);
    expect(runs.get("run-1", "identity-1")).toBeNull();
  });

  it("forgets a cancelled run once the retention period passes", async () => {
    vi.useFakeTimers();
    const { runs } = setup({ retentionMs: 500 });
    runs.start("identity-1", 1, controllableWork().work);
    runs.cancel("run-1", "identity-1");

    vi.advanceTimersByTime(500);

    expect(runs.get("run-1", "identity-1")).toBeNull();
  });

  it("uses random ids, one running run per identity and an hour of retention by default", async () => {
    vi.useFakeTimers();
    const runs = createOrganizeRuns({ clock: () => T0 });
    const control = controllableWork();

    const run = runs.start("identity-1", 1, control.work);
    expect(run.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(() => runs.start("identity-1", 1, controllableWork().work)).toThrow(OrganizeBusyError);

    // No onUnexpectedError handler: an unexpected failure is still reported generically.
    control.result.reject(new Error("boom"));
    await flush();
    expect(runs.get(run.id, "identity-1")?.error).toBe(
      "Something went wrong while organizing. Try again.",
    );

    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(runs.get(run.id, "identity-1")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(runs.get(run.id, "identity-1")).toBeNull();
  });

  it("keeps up to 200 runs by default", async () => {
    const { runs } = setup();
    for (let i = 0; i < 200; i++) runs.start(`identity-${i}`, 1, controllableWork().work);

    expect(() => runs.start("identity-200", 1, controllableWork().work)).toThrow(OrganizeBusyError);
  });

  it("names its errors", () => {
    expect(new OrganizeBusyError().name).toBe("OrganizeBusyError");
    expect(new OrganizeError("x").name).toBe("OrganizeError");
  });
});
