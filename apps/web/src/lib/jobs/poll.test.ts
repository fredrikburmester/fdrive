import type { JobStatus } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import { jobsToRefresh, pollActiveJobs } from "./poll";

function job(overrides: Partial<JobStatus> & Pick<JobStatus, "id" | "state">): JobStatus {
  return {
    kind: "compress",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    progress: { processed: 0, total: null, bytes: 0 },
    ...overrides,
  };
}

describe("jobsToRefresh", () => {
  it("returns only the fetched jobs whose id is active", () => {
    const fetched = [
      job({ id: "1", state: "failed" }),
      job({ id: "2", state: "running" }),
      job({ id: "3", state: "done" }),
    ];

    expect(jobsToRefresh(["1", "2"], fetched).map((j) => j.id)).toEqual(["1", "2"]);
  });

  it("returns an empty array when activeIds is empty, without inspecting fetched", () => {
    expect(jobsToRefresh([], [job({ id: "1", state: "running" })])).toEqual([]);
  });

  it("returns an empty array when none of the fetched jobs are active", () => {
    expect(jobsToRefresh(["missing"], [job({ id: "1", state: "running" })])).toEqual([]);
  });
});

describe("pollActiveJobs", () => {
  it("does nothing, without calling jobs(), when activeIds is empty", async () => {
    const jobs = vi.fn();
    const upsertJob = vi.fn();

    await pollActiveJobs({ jobs, upsertJob }, []);

    expect(jobs).not.toHaveBeenCalled();
    expect(upsertJob).not.toHaveBeenCalled();
  });

  it("upserts every fetched job whose id is active", async () => {
    const failed = job({ id: "1", state: "failed" });
    const unrelated = job({ id: "9", state: "done" });
    const jobs = vi.fn().mockResolvedValue([failed, unrelated]);
    const upsertJob = vi.fn();

    await pollActiveJobs({ jobs, upsertJob }, ["1"]);

    expect(upsertJob).toHaveBeenCalledTimes(1);
    expect(upsertJob).toHaveBeenCalledWith(failed);
  });

  it("swallows a failed fetch instead of throwing", async () => {
    const jobs = vi.fn().mockRejectedValue(new Error("network down"));
    const upsertJob = vi.fn();

    await expect(pollActiveJobs({ jobs, upsertJob }, ["1"])).resolves.toBeUndefined();
    expect(upsertJob).not.toHaveBeenCalled();
  });
});
