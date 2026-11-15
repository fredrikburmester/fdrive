import { describe, expect, it } from "vitest";
import {
  FsEvent,
  IndexedEvent,
  JobEvent,
  PingEvent,
  ResyncEvent,
  SSE_EVENT_ID,
  SseEvent,
} from "./events";

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
    paths: ["/a"],
    targetPaths: ["/b"],
    at: AT,
  };

  it("parses a valid move event", () => {
    expect(FsEvent.parse(valid)).toEqual(valid);
  });

  it("accepts a change without targetPaths", () => {
    const { targetPaths: _drop, ...rest } = valid;
    expect(FsEvent.safeParse({ ...rest, op: "change" }).success).toBe(true);
  });

  it.each(["create", "update", "delete", "copy", "mkdir", "rename"])("rejects op %s", (op) => {
    expect(FsEvent.safeParse({ ...valid, op }).success).toBe(false);
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

describe("ResyncEvent and IndexedEvent", () => {
  it("carry only a time", () => {
    expect(ResyncEvent.parse({ type: "resync", at: AT })).toEqual({ type: "resync", at: AT });
    expect(IndexedEvent.parse({ type: "indexed", at: AT })).toEqual({ type: "indexed", at: AT });
    expect(IndexedEvent.safeParse({ type: "indexed" }).success).toBe(false);
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
  it.each([
    { type: "fs", op: "change", paths: ["/a"], at: AT },
    { type: "ping", at: AT },
    { type: "resync", at: AT },
    { type: "indexed", at: AT },
    { type: "job", job: VALID_JOB_STATUS, at: AT },
  ])("discriminates a $type event", (payload) => {
    expect(SseEvent.safeParse(payload).success).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(SseEvent.safeParse({ type: "other", at: AT }).success).toBe(false);
  });
});

describe("SSE_EVENT_ID", () => {
  it("reads an epoch and a position", () => {
    const match = SSE_EVENT_ID.exec("123e4567-e89b-12d3-a456-426614174000.42");
    expect(match?.slice(1)).toEqual(["123e4567-e89b-12d3-a456-426614174000", "42"]);
  });

  it.each(["", "42", "not-an-epoch.1", "123e4567-e89b-12d3-a456-426614174000.1234567890123456"])(
    "refuses %j",
    (id) => {
      expect(SSE_EVENT_ID.test(id)).toBe(false);
    },
  );
});
