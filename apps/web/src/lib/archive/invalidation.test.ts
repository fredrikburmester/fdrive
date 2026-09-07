import type { FsEvent, JobEvent, PingEvent } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { archiveKeysToInvalidate } from "./invalidation";
import { archiveEntriesKey } from "./queries";

function fsEvent(overrides: Partial<FsEvent> = {}): FsEvent {
  return {
    type: "fs",
    op: "update",
    identityId: "00000000-0000-0000-0000-000000000000",
    paths: ["/a/b.zip"],
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
    kind: "extract",
    state: "running",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    progress: { processed: 0, total: null, bytes: 0 },
  },
};

describe("archiveKeysToInvalidate", () => {
  it("invalidates the archive-entries query for every affected path", () => {
    expect(archiveKeysToInvalidate(fsEvent({ paths: ["/a.zip"] }))).toEqual([
      archiveEntriesKey("/a.zip"),
    ]);
  });

  it("invalidates target paths too, for a move or copy", () => {
    expect(
      archiveKeysToInvalidate(
        fsEvent({ op: "move", paths: ["/old.zip"], targetPaths: ["/new.zip"] }),
      ),
    ).toEqual([archiveEntriesKey("/old.zip"), archiveEntriesKey("/new.zip")]);
  });

  it("invalidates nothing for a ping event", () => {
    expect(archiveKeysToInvalidate(PING_EVENT)).toEqual([]);
  });

  it("invalidates nothing for a job event", () => {
    expect(archiveKeysToInvalidate(JOB_EVENT)).toEqual([]);
  });
});
