import { describe, expect, it } from "vitest";
import { FsEvent, JobEvent, PingEvent, SseEvent } from "./events";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const AT = "2026-01-01T00:00:00.000Z";

const VALID_JOB_STATUS = {
  id: "job-1",
  kind: "compress",
  state: "running",
  createdAt: AT,
  updatedAt: AT,
  progress: { processed: 1, total: 4, bytes: 10 },
};

describe("FsEvent", () => {
  const valid = {
    type: "fs",
    op: "move",
    identityId: VALID_UUID,
    paths: ["/a"],
    targetPaths: ["/b"],
    at: AT,
  };

  it("parses a valid move event", () => {
    expect(FsEvent.parse(valid)).toEqual(valid);
  });

  it("accepts an event without targetPaths", () => {
    const { targetPaths: _drop, ...rest } = valid;
    expect(FsEvent.safeParse(rest).success).toBe(true);
  });

  it.each(["create", "update", "delete", "move", "copy", "mkdir"])("accepts op %s", (op) => {
    expect(FsEvent.safeParse({ ...valid, op }).success).toBe(true);
  });

  it("rejects an unknown op", () => {
    expect(FsEvent.safeParse({ ...valid, op: "rename" }).success).toBe(false);
  });

  it("rejects a non-uuid identityId", () => {
    expect(FsEvent.safeParse({ ...valid, identityId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a non-ISO at", () => {
    expect(FsEvent.safeParse({ ...valid, at: "not-a-date" }).success).toBe(false);
  });
});

describe("PingEvent", () => {
  it("parses a valid ping", () => {
    expect(PingEvent.parse({ type: "ping", at: AT })).toEqual({ type: "ping", at: AT });
  });

  it("rejects a ping missing at", () => {
    expect(PingEvent.safeParse({ type: "ping" }).success).toBe(false);
  });
});

describe("JobEvent", () => {
  it("parses a valid job event", () => {
    const valid = { type: "job", job: VALID_JOB_STATUS, at: AT };
    expect(JobEvent.parse(valid)).toEqual(valid);
  });

  it("rejects a job event with an invalid job", () => {
    const invalid = { type: "job", job: { ...VALID_JOB_STATUS, state: "unknown" }, at: AT };
    expect(JobEvent.safeParse(invalid).success).toBe(false);
  });
});

describe("SseEvent", () => {
  it("discriminates an fs event", () => {
    const payload = {
      type: "fs",
      op: "create",
      identityId: VALID_UUID,
      paths: ["/a"],
      at: AT,
    };
    const result = SseEvent.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("discriminates a ping event", () => {
    const result = SseEvent.safeParse({ type: "ping", at: AT });
    expect(result.success).toBe(true);
  });

  it("discriminates a job event", () => {
    const result = SseEvent.safeParse({ type: "job", job: VALID_JOB_STATUS, at: AT });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(SseEvent.safeParse({ type: "other", at: AT }).success).toBe(false);
  });
});
