import { describe, expect, it } from "vitest";
import { placeholderJob } from "./placeholder";

describe("placeholderJob", () => {
  it("builds a queued job with zeroed progress", () => {
    const job = placeholderJob("job-1", "compress", () => "2026-09-06T00:00:00.000Z");

    expect(job).toEqual({
      id: "job-1",
      kind: "compress",
      state: "queued",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      progress: { processed: 0, total: null, bytes: 0 },
    });
  });

  it("stamps createdAt and updatedAt with the same timestamp", () => {
    const job = placeholderJob("job-2", "extract", () => "2026-09-06T01:02:03.000Z");
    expect(job.createdAt).toBe(job.updatedAt);
  });

  it("defaults to the current time when no clock is given", () => {
    const job = placeholderJob("job-3", "extract");
    expect(() => new Date(job.createdAt).toISOString()).not.toThrow();
  });
});
