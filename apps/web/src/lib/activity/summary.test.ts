import { describe, expect, it } from "vitest";
import { activityTitle } from "./summary";

const BASE = { activeCount: 0, uploadsDone: 0, uploadsFailed: 0, jobsDone: 0, jobsFailed: 0 };

describe("activityTitle", () => {
  it("reports how many items are in flight, plural", () => {
    expect(activityTitle({ ...BASE, activeCount: 3 })).toBe("Working on 3 items");
  });

  it("uses the singular for exactly one active item", () => {
    expect(activityTitle({ ...BASE, activeCount: 1 })).toBe("Working on 1 item");
  });

  it("summarizes finished uploads only", () => {
    expect(activityTitle({ ...BASE, uploadsDone: 5 })).toBe("5 uploaded");
  });

  it("summarizes finished jobs only", () => {
    expect(activityTitle({ ...BASE, jobsDone: 2 })).toBe("2 finished");
  });

  it("combines uploads and jobs", () => {
    expect(activityTitle({ ...BASE, uploadsDone: 5, jobsDone: 2 })).toBe("5 uploaded, 2 finished");
  });

  it("appends a combined failure count", () => {
    expect(
      activityTitle({ ...BASE, uploadsDone: 5, uploadsFailed: 1, jobsDone: 2, jobsFailed: 1 }),
    ).toBe("5 uploaded, 2 finished, 2 failed");
  });

  it("counts failures even when nothing succeeded", () => {
    expect(activityTitle({ ...BASE, uploadsFailed: 2 })).toBe("0 uploaded, 2 failed");
  });

  it("falls back to 'All done' when there is nothing to report", () => {
    expect(activityTitle(BASE)).toBe("All done");
  });

  it("prioritizes the active count over any finished summary", () => {
    expect(activityTitle({ ...BASE, activeCount: 1, uploadsDone: 5 })).toBe("Working on 1 item");
  });
});
