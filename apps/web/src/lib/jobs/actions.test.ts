import type { JobStatus } from "@fdrive/contracts";
import { ApiClientError } from "@fdrive/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type CancelJobDeps,
  cancelJob,
  type RetryJobDeps,
  retryJob,
  runJobRequest,
} from "./actions";
import type { JobRequest } from "./types";

const COMPRESS_REQUEST: JobRequest = {
  kind: "compress",
  req: { paths: ["/docs"], format: "zip", name: "docs" },
};

const EXTRACT_REQUEST: JobRequest = {
  kind: "extract",
  req: { path: "/docs.zip" },
};

function job(overrides: Partial<JobStatus> & Pick<JobStatus, "id" | "state">): JobStatus {
  return {
    kind: "compress",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    progress: { processed: 0, total: null, bytes: 0 },
    ...overrides,
  };
}

describe("runJobRequest", () => {
  it("submits a compress request and upserts a placeholder job with the request remembered", async () => {
    const compress = vi.fn().mockResolvedValue({ jobId: "job-1" });
    const extract = vi.fn();
    const upsertJob = vi.fn();
    const notifySuccess = vi.fn();
    const notifyError = vi.fn();

    await runJobRequest(
      {
        compress,
        extract,
        upsertJob,
        notifySuccess,
        notifyError,
        now: () => "2026-09-06T00:00:00.000Z",
      },
      COMPRESS_REQUEST,
    );

    expect(compress).toHaveBeenCalledWith(COMPRESS_REQUEST.req);
    expect(extract).not.toHaveBeenCalled();
    expect(upsertJob).toHaveBeenCalledWith(
      {
        id: "job-1",
        kind: "compress",
        state: "queued",
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
        progress: { processed: 0, total: null, bytes: 0 },
      },
      COMPRESS_REQUEST,
    );
    expect(notifySuccess).toHaveBeenCalledWith("Compressing…");
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("submits an extract request", async () => {
    const compress = vi.fn();
    const extract = vi.fn().mockResolvedValue({ jobId: "job-2" });
    const upsertJob = vi.fn();
    const notifySuccess = vi.fn();
    const notifyError = vi.fn();

    await runJobRequest(
      { compress, extract, upsertJob, notifySuccess, notifyError },
      EXTRACT_REQUEST,
    );

    expect(extract).toHaveBeenCalledWith(EXTRACT_REQUEST.req);
    expect(compress).not.toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalledWith("Extracting…");
  });

  it("reports the API's error message on failure, and never upserts", async () => {
    const compress = vi
      .fn()
      .mockRejectedValue(new ApiClientError("conflict", "already exists", 409));
    const extract = vi.fn();
    const upsertJob = vi.fn();
    const notifySuccess = vi.fn();
    const notifyError = vi.fn();

    await runJobRequest(
      { compress, extract, upsertJob, notifySuccess, notifyError },
      COMPRESS_REQUEST,
    );

    expect(upsertJob).not.toHaveBeenCalled();
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith("already exists");
  });

  it("falls back to a generic message for a non-ApiClientError failure", async () => {
    const compress = vi.fn();
    const extract = vi.fn().mockRejectedValue(new Error("boom"));
    const notifyError = vi.fn();

    await runJobRequest(
      { compress, extract, upsertJob: vi.fn(), notifySuccess: vi.fn(), notifyError },
      EXTRACT_REQUEST,
    );

    expect(notifyError).toHaveBeenCalledWith("Could not start extracting.");
  });
});

describe("retryJob", () => {
  function deps(overrides: Partial<RetryJobDeps> = {}): RetryJobDeps {
    return {
      compress: vi.fn().mockResolvedValue({ jobId: "job-retry" }),
      extract: vi.fn().mockResolvedValue({ jobId: "job-retry" }),
      upsertJob: vi.fn(),
      notifySuccess: vi.fn(),
      notifyError: vi.fn(),
      getRequest: vi.fn().mockReturnValue(undefined),
      notifyMissingRequest: vi.fn(),
      ...overrides,
    };
  }

  it("resubmits the remembered request", async () => {
    const d = deps({ getRequest: vi.fn().mockReturnValue(COMPRESS_REQUEST) });

    await retryJob(d, "job-1");

    expect(d.compress).toHaveBeenCalledWith(COMPRESS_REQUEST.req);
    expect(d.notifyMissingRequest).not.toHaveBeenCalled();
  });

  it("reports a missing request instead of guessing one", async () => {
    const d = deps();

    await retryJob(d, "job-1");

    expect(d.compress).not.toHaveBeenCalled();
    expect(d.extract).not.toHaveBeenCalled();
    expect(d.notifyMissingRequest).toHaveBeenCalledWith(
      "Can't retry: the original request is no longer available.",
    );
  });
});

describe("cancelJob", () => {
  function deps(overrides: Partial<CancelJobDeps> = {}): CancelJobDeps {
    return {
      cancel: vi.fn().mockResolvedValue(job({ id: "job-1", state: "cancelled" })),
      upsertJob: vi.fn(),
      notifyError: vi.fn(),
      ...overrides,
    };
  }

  it("cancels the job and stores the resulting status", async () => {
    const d = deps();

    await cancelJob(d, "job-1");

    expect(d.cancel).toHaveBeenCalledWith("job-1");
    expect(d.upsertJob).toHaveBeenCalledWith(job({ id: "job-1", state: "cancelled" }));
  });

  it("reports the API's error message on failure", async () => {
    const d = deps({
      cancel: vi.fn().mockRejectedValue(new ApiClientError("not_found", "no such job", 404)),
    });

    await cancelJob(d, "job-1");

    expect(d.upsertJob).not.toHaveBeenCalled();
    expect(d.notifyError).toHaveBeenCalledWith("no such job");
  });
});
