import { describe, expect, it } from "vitest";
import {
  ArchiveFormat,
  JobAccepted,
  JobKind,
  JobProgress,
  JobState,
  JobStatus,
  JobsResponse,
} from "./jobs";

const AT = "2026-01-01T00:00:00.000Z";

describe("ArchiveFormat", () => {
  it.each(["zip", "tar.gz", "tar.zst"])("accepts %s", (format) => {
    expect(ArchiveFormat.safeParse(format).success).toBe(true);
  });

  it("rejects an unknown format", () => {
    expect(ArchiveFormat.safeParse("rar").success).toBe(false);
  });
});

describe("JobKind", () => {
  it.each(["compress", "extract"])("accepts %s", (kind) => {
    expect(JobKind.safeParse(kind).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(JobKind.safeParse("duplicate").success).toBe(false);
  });
});

describe("JobState", () => {
  it.each(["queued", "running", "done", "failed", "cancelled"])("accepts %s", (state) => {
    expect(JobState.safeParse(state).success).toBe(true);
  });

  it("rejects an unknown state", () => {
    expect(JobState.safeParse("paused").success).toBe(false);
  });
});

describe("JobProgress", () => {
  it("parses with a numeric total", () => {
    const payload = { processed: 1, total: 4, bytes: 100 };
    expect(JobProgress.parse(payload)).toEqual(payload);
  });

  it("parses with a null total", () => {
    expect(JobProgress.safeParse({ processed: 0, total: null, bytes: 0 }).success).toBe(true);
  });

  it("rejects a negative processed", () => {
    expect(JobProgress.safeParse({ processed: -1, total: null, bytes: 0 }).success).toBe(false);
  });
});

const VALID_JOB_STATUS = {
  id: "job-1",
  kind: "compress",
  state: "queued",
  createdAt: AT,
  updatedAt: AT,
  progress: { processed: 0, total: null, bytes: 0 },
};

describe("JobStatus", () => {
  it("parses the minimal shape", () => {
    expect(JobStatus.parse(VALID_JOB_STATUS)).toEqual(VALID_JOB_STATUS);
  });

  it("parses with a result", () => {
    const payload = { ...VALID_JOB_STATUS, state: "done", result: { path: "/out.zip" } };
    expect(JobStatus.parse(payload)).toEqual(payload);
  });

  it("parses with an error", () => {
    const payload = { ...VALID_JOB_STATUS, state: "failed", error: "boom" };
    expect(JobStatus.parse(payload)).toEqual(payload);
  });

  it("rejects a non-ISO createdAt", () => {
    expect(JobStatus.safeParse({ ...VALID_JOB_STATUS, createdAt: "nope" }).success).toBe(false);
  });
});

describe("JobAccepted", () => {
  it("parses a jobId", () => {
    expect(JobAccepted.safeParse({ jobId: "job-1" }).success).toBe(true);
  });

  it("parses both id and jobId", () => {
    expect(JobAccepted.parse({ id: "job-1", jobId: "job-1" })).toEqual({
      id: "job-1",
      jobId: "job-1",
    });
  });

  it("rejects a missing jobId", () => {
    expect(JobAccepted.safeParse({}).success).toBe(false);
  });
});

describe("JobsResponse", () => {
  it("parses a list of jobs", () => {
    const payload = { jobs: [VALID_JOB_STATUS] };
    expect(JobsResponse.parse(payload)).toEqual(payload);
  });

  it("accepts an empty list", () => {
    expect(JobsResponse.safeParse({ jobs: [] }).success).toBe(true);
  });
});
