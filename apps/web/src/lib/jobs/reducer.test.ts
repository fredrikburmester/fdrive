import type { JobStatus } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { activeJobs, finishedJobs, initialJobsState, jobsReducer } from "./reducer";
import type { JobRequest } from "./types";

function job(overrides: Partial<JobStatus> & Pick<JobStatus, "id" | "state">): JobStatus {
  return {
    kind: "compress",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    progress: { processed: 0, total: null, bytes: 0 },
    ...overrides,
  };
}

const COMPRESS_REQUEST: JobRequest = {
  kind: "compress",
  req: { paths: ["/a"], format: "zip" },
};

describe("jobsReducer", () => {
  it("hydrates from a list of jobs, in order", () => {
    const jobs = [job({ id: "1", state: "running" }), job({ id: "2", state: "done" })];
    const state = jobsReducer(initialJobsState, { type: "hydrate", jobs });

    expect(state.order).toEqual(["1", "2"]);
    expect(state.byId["1"]).toEqual(jobs[0]);
    expect(state.byId["2"]).toEqual(jobs[1]);
    expect(state.requests).toEqual({});
  });

  it("hydrate keeps remembered requests only for jobs that survived", () => {
    const withRequest = jobsReducer(initialJobsState, {
      type: "upsert",
      job: job({ id: "1", state: "queued" }),
      request: COMPRESS_REQUEST,
    });

    const rehydrated = jobsReducer(withRequest, {
      type: "hydrate",
      jobs: [job({ id: "1", state: "done" }), job({ id: "2", state: "queued" })],
    });

    expect(rehydrated.requests).toEqual({ "1": COMPRESS_REQUEST });
  });

  it("upsert appends a new job to the end of order", () => {
    const first = jobsReducer(initialJobsState, {
      type: "upsert",
      job: job({ id: "1", state: "queued" }),
    });
    const second = jobsReducer(first, {
      type: "upsert",
      job: job({ id: "2", state: "queued" }),
    });

    expect(second.order).toEqual(["1", "2"]);
  });

  it("upsert updates an existing job in place, without reordering", () => {
    const first = jobsReducer(initialJobsState, {
      type: "upsert",
      job: job({ id: "1", state: "queued" }),
    });
    const withSecond = jobsReducer(first, {
      type: "upsert",
      job: job({ id: "2", state: "queued" }),
    });
    const updated = jobsReducer(withSecond, {
      type: "upsert",
      job: job({ id: "1", state: "running" }),
    });

    expect(updated.order).toEqual(["1", "2"]);
    expect(updated.byId["1"]?.state).toBe("running");
  });

  it("upsert remembers the request when given one", () => {
    const state = jobsReducer(initialJobsState, {
      type: "upsert",
      job: job({ id: "1", state: "queued" }),
      request: COMPRESS_REQUEST,
    });

    expect(state.requests["1"]).toEqual(COMPRESS_REQUEST);
  });

  it("upsert without a request leaves an existing remembered request untouched", () => {
    const withRequest = jobsReducer(initialJobsState, {
      type: "upsert",
      job: job({ id: "1", state: "queued" }),
      request: COMPRESS_REQUEST,
    });
    const updated = jobsReducer(withRequest, {
      type: "upsert",
      job: job({ id: "1", state: "running" }),
    });

    expect(updated.requests["1"]).toEqual(COMPRESS_REQUEST);
  });

  it("remove drops the job, its order entry, and its remembered request", () => {
    const withRequest = jobsReducer(initialJobsState, {
      type: "upsert",
      job: job({ id: "1", state: "done" }),
      request: COMPRESS_REQUEST,
    });

    const removed = jobsReducer(withRequest, { type: "remove", id: "1" });

    expect(removed.order).toEqual([]);
    expect(removed.byId["1"]).toBeUndefined();
    expect(removed.requests["1"]).toBeUndefined();
  });

  it("remove is a no-op for an id that is not present", () => {
    const state = jobsReducer(initialJobsState, { type: "remove", id: "missing" });
    expect(state).toBe(initialJobsState);
  });
});

describe("activeJobs", () => {
  it("returns only queued and running jobs, in order", () => {
    let state = initialJobsState;
    for (const j of [
      job({ id: "1", state: "queued" }),
      job({ id: "2", state: "done" }),
      job({ id: "3", state: "running" }),
      job({ id: "4", state: "failed" }),
    ]) {
      state = jobsReducer(state, { type: "upsert", job: j });
    }

    expect(activeJobs(state).map((j) => j.id)).toEqual(["1", "3"]);
  });
});

describe("finishedJobs", () => {
  it("returns done, failed, and cancelled jobs, in order", () => {
    let state = initialJobsState;
    for (const j of [
      job({ id: "1", state: "queued" }),
      job({ id: "2", state: "done" }),
      job({ id: "3", state: "failed" }),
      job({ id: "4", state: "cancelled" }),
    ]) {
      state = jobsReducer(state, { type: "upsert", job: j });
    }

    expect(finishedJobs(state).map((j) => j.id)).toEqual(["2", "3", "4"]);
  });
});
