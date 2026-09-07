import type { FsEvent, JobEvent, PingEvent } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { trashKeysToInvalidate } from "./invalidation";

function fsEvent(overrides: Partial<FsEvent> = {}): FsEvent {
  return {
    type: "fs",
    op: "update",
    identityId: "00000000-0000-0000-0000-000000000000",
    paths: ["/a/b.txt"],
    at: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

const PING_EVENT: PingEvent = { type: "ping", at: "2026-09-06T00:00:00.000Z" };

const JOB_EVENT: JobEvent = {
  type: "job",
  at: "2026-09-06T00:00:00.000Z",
  job: {
    id: "1",
    kind: "compress",
    state: "running",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    progress: { processed: 0, total: null, bytes: 0 },
  },
};

describe("trashKeysToInvalidate", () => {
  it("invalidates the trash list for any fs event", () => {
    expect(trashKeysToInvalidate(fsEvent({ op: "delete" }))).toEqual([["trash", "list"]]);
    expect(trashKeysToInvalidate(fsEvent({ op: "move" }))).toEqual([["trash", "list"]]);
    expect(trashKeysToInvalidate(fsEvent({ op: "update" }))).toEqual([["trash", "list"]]);
  });

  it("invalidates nothing for a ping event", () => {
    expect(trashKeysToInvalidate(PING_EVENT)).toEqual([]);
  });

  it("invalidates nothing for a job event", () => {
    expect(trashKeysToInvalidate(JOB_EVENT)).toEqual([]);
  });
});
