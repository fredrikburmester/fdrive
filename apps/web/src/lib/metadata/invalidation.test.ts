import type { FsEvent, JobEvent, PingEvent } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { metadataKeysToInvalidate } from "./invalidation";

function fsEvent(overrides: Partial<FsEvent> = {}): FsEvent {
  return {
    type: "fs",
    op: "change",
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
  it.each(["move", "change"] as const)(
    "invalidates favorites, recents, and tag files for a %s",
    (op) => {
      expect(metadataKeysToInvalidate(fsEvent({ op }))).toEqual([
        ["favorites", "list"],
        ["recents", "list"],
        ["tags", "files"],
      ]);
    },
  );

  it("invalidates nothing for a ping event", () => {
    expect(metadataKeysToInvalidate(PING_EVENT)).toEqual([]);
  });

  it("invalidates nothing for a job event", () => {
    expect(metadataKeysToInvalidate(JOB_EVENT)).toEqual([]);
  });
});
