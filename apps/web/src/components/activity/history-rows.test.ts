import type { PersonalActivityEvent } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  activityFailed,
  activityFolder,
  activityItemName,
  activityOrigin,
  activityResult,
  dayLabel,
  eventCountLabel,
  groupByDay,
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

  it("reads the result from the outcome, a provisional read, or an action still under way", () => {
    expect(activityResult(base)).toBe("success");
    expect(activityResult({ ...base, outcome: "conflict" })).toBe("conflict");
    expect(activityResult({ ...base, outcome: null })).toBe("Started");
    expect(activityResult({ ...base, provisional: true })).toBe("Recent");
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
