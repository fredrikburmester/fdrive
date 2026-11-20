import type { PersonalActivityEvent } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  activityAction,
  activityFailed,
  activityFolder,
  activityItemName,
  activityOrigin,
  activityResult,
  activityResultTone,
  activitySource,
  dayLabel,
  eventCountLabel,
  eventKey,
  fileAvailability,
  groupByDay,
  sentenceCase,
  uncertaintyNotes,
} from "./history-rows";

const base: PersonalActivityEvent = {
  schemaVersion: 1,
  id: "00000000-0000-4000-8000-000000000001",
  sequence: "1",
  identityId: "00000000-0000-4000-8000-0000000000aa",
  actorAccountId: null,
  fileId: null,
  action: "file.upload",
  class: "action",
  stage: "outcome",
  outcome: "success",
  source: "web",
  evidence: "server_confirmed",
  operationId: null,
  batchId: null,
  parentEventId: null,
  occurredAt: null,
  recordedAt: "2026-03-10T12:00:00.000Z",
  sortAt: "2026-03-10T12:00:00.000Z",
  lastConfirmedAt: null,
  detectedAt: null,
  before: null,
  after: null,
  detail: null,
  errorCode: null,
  count: 1,
  firstAt: null,
  lastAt: null,
  outcomeCounts: null,
  subjects: [],
  subjectsTruncated: false,
  provisional: false,
};

/** An event at a local wall-clock time, so the day it falls on does not depend on the time zone. */
function at(id: string, ...time: [number, number, number, number]): PersonalActivityEvent {
  return { ...base, id, sortAt: new Date(...time, 0).toISOString() };
}

// 18:00 on Tuesday, March 10, 2026, local time.
const now = new Date(2026, 2, 10, 18, 0);

describe("groupByDay", () => {
  it("splits events into the local days they happened on, newest day first", () => {
    const days = groupByDay(
      [
        at("morning", 2026, 2, 10, 9),
        at("early", 2026, 2, 10, 0),
        at("late-yesterday", 2026, 2, 9, 23),
        at("earlier", 2026, 2, 1, 12),
      ],
      now,
      "en-US",
    );

    expect(days.map((day) => [day.key, day.label, day.events.map((event) => event.id)])).toEqual([
      ["2026-03-10", "Today", ["morning", "early"]],
      ["2026-03-09", "Yesterday", ["late-yesterday"]],
      ["2026-03-01", "Sunday, March 1", ["earlier"]],
    ]);
  });

  it("returns no days for no events", () => {
    expect(groupByDay([], now)).toEqual([]);
  });

  it("measures today from the current time unless told otherwise", () => {
    const [day] = groupByDay([at("long-ago", 2001, 0, 5, 12)]);
    expect(day?.key).toBe("2001-01-05");
    expect(day?.label).not.toBe("Today");
    expect(day?.label).not.toBe("Yesterday");
  });
});

describe("dayLabel", () => {
  it("names today and yesterday, across a month boundary too", () => {
    expect(dayLabel(new Date(2026, 2, 10, 0, 1), now, "en-US")).toBe("Today");
    expect(dayLabel(new Date(2026, 2, 9, 23, 59), now, "en-US")).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 1, 28, 12), new Date(2026, 2, 1, 8), "en-US")).toBe("Yesterday");
  });

  it("writes out other days, with the year only when it is not this one", () => {
    expect(dayLabel(new Date(2026, 2, 8, 12), now, "en-US")).toBe("Sunday, March 8");
    expect(dayLabel(new Date(2025, 11, 1, 12), now, "en-US")).toBe("Monday, December 1, 2025");
    // Tomorrow is not "Today": only the same calendar day is.
    expect(dayLabel(new Date(2026, 2, 11, 1), now, "en-US")).toBe("Wednesday, March 11");
  });
});

describe("what a row shows", () => {
  it("names an item by its last segment, and the top folder as Home", () => {
    expect(activityItemName("/docs/report.txt")).toBe("report.txt");
    expect(activityItemName("/")).toBe("Home");
  });

  it("locates an item by its folder, Home at the top", () => {
    expect(activityFolder("/docs/2026/report.txt")).toBe("/docs/2026");
    expect(activityFolder("/report.txt")).toBe("Home");
  });

  it("says where a renamed or moved item came from", () => {
    const renamed = { ...base, before: { path: "/docs/draft.txt" } };
    expect(activityOrigin(renamed, "/docs/report.txt")).toBe("draft.txt");
    const moved = { ...base, before: { path: "/inbox/report.txt" } };
    expect(activityOrigin(moved, "/docs/report.txt")).toBe("/inbox/report.txt");
  });

  it("names no origin for an item that stayed where it was", () => {
    expect(activityOrigin(base, "/docs/report.txt")).toBeNull();
    expect(activityOrigin({ ...base, before: {} }, "/docs/report.txt")).toBeNull();
    const same = { ...base, before: { path: "/docs/report.txt" } };
    expect(activityOrigin(same, "/docs/report.txt")).toBeNull();
  });

  it("says what happened, and how often when it repeated", () => {
    expect(activityAction(base)).toBe("Uploaded");
    expect(activityAction({ ...base, action: "file.open", count: 3 })).toBe("Opened 3 times");
  });

  it("names the client an action came from", () => {
    expect(activitySource("web")).toBe("Web");
    expect(activitySource("api")).toBe("API");
    expect(activitySource("native")).toBe("Native app");
  });

  it("writes a recorded value as words, the first one capitalized", () => {
    expect(sentenceCase("server_confirmed")).toBe("Server confirmed");
    expect(sentenceCase("failed")).toBe("Failed");
    expect(sentenceCase("")).toBe("");
  });

  it("reads the result from the outcome, a provisional read, or an action still under way", () => {
    expect(activityResult(base)).toBe("Success");
    expect(activityResult({ ...base, outcome: "conflict" })).toBe("Conflict");
    expect(activityResult({ ...base, outcome: null })).toBe("Started");
    expect(activityResult({ ...base, provisional: true })).toBe("Recent");
  });

  it("colors the result by how the action ended", () => {
    expect(activityResultTone(base)).toBe("success");
    expect(activityResultTone({ ...base, outcome: "failed" })).toBe("danger");
    expect(activityResultTone({ ...base, outcome: "denied" })).toBe("danger");
    expect(activityResultTone({ ...base, outcome: "partial" })).toBe("warning");
    expect(activityResultTone({ ...base, outcome: "conflict" })).toBe("warning");
    // Nothing to judge yet, or nothing known: no color.
    expect(activityResultTone({ ...base, outcome: null })).toBe("neutral");
    expect(activityResultTone({ ...base, outcome: "unknown" })).toBe("neutral");
    expect(activityResultTone({ ...base, outcome: "cancelled" })).toBe("neutral");
    expect(activityResultTone({ ...base, provisional: true })).toBe("neutral");
  });

  it("flags only an action that did not go through", () => {
    expect(activityFailed({ ...base, outcome: "failed" })).toBe(true);
    expect(activityFailed({ ...base, outcome: "denied" })).toBe(true);
    expect(activityFailed(base)).toBe(false);
    expect(activityFailed({ ...base, outcome: "partial" })).toBe(false);
    expect(activityFailed({ ...base, outcome: null })).toBe(false);
  });

  it("counts the events shown, with a plus while more can load", () => {
    expect(eventCountLabel(0, false)).toBe("0 events");
    expect(eventCountLabel(1, false)).toBe("1 event");
    expect(eventCountLabel(12, false)).toBe("12 events");
    expect(eventCountLabel(1, true)).toBe("1+ events");
    expect(eventCountLabel(50, true)).toBe("50+ events");
  });
});

describe("which row an event is", () => {
  it("keeps an operation's row from its intent to its outcome", () => {
    const operationId = "00000000-0000-4000-8000-0000000000c1";
    const intent = { ...base, id: "00000000-0000-4000-8000-000000000011", operationId };
    const outcome = { ...base, id: "00000000-0000-4000-8000-000000000012", operationId };
    expect(eventKey(intent)).toBe(operationId);
    expect(eventKey(outcome)).toBe(eventKey(intent));
  });

  it("falls back to the event itself when it belongs to no operation", () => {
    expect(eventKey(base)).toBe(base.id);
  });
});

describe("what an observation leaves uncertain", () => {
  it("says nothing about a confirmed action", () => {
    expect(uncertaintyNotes(base)).toEqual([]);
  });

  it("says the author of an observed change is unknown", () => {
    const missing = {
      ...base,
      action: "observation.location_missing" as const,
      class: "observation" as const,
    };
    expect(uncertaintyNotes(missing)).toEqual([
      "Detected outside a confirmed fdrive action. Who made this change is unknown.",
    ]);
  });

  it("adds that a resolved location may hold a different file", () => {
    const resolved = {
      ...base,
      action: "observation.resolved" as const,
      class: "observation" as const,
    };
    const notes = uncertaintyNotes(resolved);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatch(/Whether this is the earlier file remains unknown/);
  });
});

describe("whether a journey's file can be reached", () => {
  it("gives each state a word and a tone", () => {
    expect(fileAvailability("live")).toEqual({ label: "Live", tone: "success" });
    expect(fileAvailability("trashed")).toEqual({ label: "In Trash", tone: "neutral" });
    expect(fileAvailability("deleted")).toEqual({ label: "Deleted", tone: "off" });
    expect(fileAvailability("unknown")).toEqual({ label: "Unknown", tone: "warning" });
    expect(fileAvailability("unavailable")).toEqual({ label: "Unavailable", tone: "warning" });
  });
});
