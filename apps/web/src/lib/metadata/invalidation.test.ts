import type { FsEvent, JobEvent, PingEvent } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { metadataKeysToInvalidate } from "./invalidation";

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

describe("metadataKeysToInvalidate", () => {
  it("invalidates favorites, recents, and tag files for a move", () => {
    expect(metadataKeysToInvalidate(fsEvent({ op: "move" }))).toEqual([
      ["favorites", "list"],
      ["recents", "list"],
      ["tags", "files"],
    ]);
  });

  it("invalidates favorites, recents, and tag files for a delete", () => {
    expect(metadataKeysToInvalidate(fsEvent({ op: "delete" }))).toEqual([
      ["favorites", "list"],
      ["recents", "list"],
      ["tags", "files"],
    ]);
  });

  it("invalidates nothing for an update", () => {
    expect(metadataKeysToInvalidate(fsEvent({ op: "update" }))).toEqual([]);
  });

  it("invalidates nothing for a copy or mkdir", () => {
    expect(metadataKeysToInvalidate(fsEvent({ op: "copy" }))).toEqual([]);
    expect(metadataKeysToInvalidate(fsEvent({ op: "mkdir" }))).toEqual([]);
  });

  it("invalidates nothing for a ping event", () => {
    expect(metadataKeysToInvalidate(PING_EVENT)).toEqual([]);
  });

  it("invalidates nothing for a job event", () => {
    expect(metadataKeysToInvalidate(JOB_EVENT)).toEqual([]);
  });
});
