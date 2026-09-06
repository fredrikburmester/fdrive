import type { JobStatus } from "@fdrive/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { initialJobsState } from "./reducer";
import { useJobsStore } from "./store";
import type { JobRequest } from "./types";

function job(overrides: Partial<JobStatus> & Pick<JobStatus, "id" | "state">): JobStatus {
  return {
    kind: "extract",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    progress: { processed: 0, total: null, bytes: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  useJobsStore.setState({ state: initialJobsState });
});

describe("useJobsStore", () => {
  it("starts empty", () => {
    expect(useJobsStore.getState().state).toEqual(initialJobsState);
  });

  it("hydrate replaces the set of known jobs", () => {
    const jobs = [job({ id: "1", state: "running" })];
    useJobsStore.getState().hydrate(jobs);

    expect(useJobsStore.getState().state.order).toEqual(["1"]);
    expect(useJobsStore.getState().state.byId["1"]).toEqual(jobs[0]);
  });

  it("upsert adds a job and can remember its request", () => {
    const request: JobRequest = { kind: "extract", req: { path: "/a.zip" } };
    useJobsStore.getState().upsert(job({ id: "1", state: "queued" }), request);

    expect(useJobsStore.getState().state.byId["1"]?.state).toBe("queued");
    expect(useJobsStore.getState().state.requests["1"]).toEqual(request);
  });

  it("upsert updates a job already in the store", () => {
    useJobsStore.getState().upsert(job({ id: "1", state: "queued" }));
    useJobsStore.getState().upsert(job({ id: "1", state: "done" }));

    expect(useJobsStore.getState().state.byId["1"]?.state).toBe("done");
    expect(useJobsStore.getState().state.order).toEqual(["1"]);
  });

  it("seed adds a job and remembers its request", () => {
    const request: JobRequest = { kind: "extract", req: { path: "/a.zip" } };
    useJobsStore.getState().seed(job({ id: "1", state: "queued" }), request);

    expect(useJobsStore.getState().state.byId["1"]?.state).toBe("queued");
    expect(useJobsStore.getState().state.requests["1"]).toEqual(request);
  });

  it("seed never overwrites a job already in the store", () => {
    const request: JobRequest = { kind: "extract", req: { path: "/a.zip" } };
    useJobsStore.getState().upsert(job({ id: "1", state: "failed" }));
    useJobsStore.getState().seed(job({ id: "1", state: "queued" }), request);

    expect(useJobsStore.getState().state.byId["1"]?.state).toBe("failed");
    expect(useJobsStore.getState().state.requests["1"]).toEqual(request);
  });

  it("remove drops a job from the store", () => {
    useJobsStore.getState().upsert(job({ id: "1", state: "done" }));
    useJobsStore.getState().remove("1");

    expect(useJobsStore.getState().state.byId["1"]).toBeUndefined();
  });
});
