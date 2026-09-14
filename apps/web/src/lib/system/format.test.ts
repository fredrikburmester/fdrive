import { describe, expect, it } from "vitest";
import { formatRelativeTime, formatUptime } from "./format";

const NOW = new Date("2026-01-01T12:00:00.000Z");

describe("formatRelativeTime", () => {
  it("returns 'just now' for a time under a minute in the past", () => {
    const target = new Date(NOW.getTime() - 30_000);
    expect(formatRelativeTime(target, NOW)).toBe("just now");
  });

  it("returns 'just now' for a time under a minute in the future", () => {
    const target = new Date(NOW.getTime() + 30_000);
    expect(formatRelativeTime(target, NOW)).toBe("just now");
  });

  it("formats minutes in the past", () => {
    const target = new Date(NOW.getTime() - 5 * 60_000);
    expect(formatRelativeTime(target, NOW)).toBe("5m ago");
  });

  it("formats minutes in the future", () => {
    const target = new Date(NOW.getTime() + 5 * 60_000);
    expect(formatRelativeTime(target, NOW)).toBe("in 5m");
  });

  it("formats hours in the past", () => {
    const target = new Date(NOW.getTime() - 3 * 3_600_000);
    expect(formatRelativeTime(target, NOW)).toBe("3h ago");
  });

  it("formats hours in the future", () => {
    const target = new Date(NOW.getTime() + 3 * 3_600_000);
    expect(formatRelativeTime(target, NOW)).toBe("in 3h");
  });

  it("formats days in the past", () => {
    const target = new Date(NOW.getTime() - 2 * 86_400_000);
    expect(formatRelativeTime(target, NOW)).toBe("2d ago");
  });

  it("formats days in the future", () => {
    const target = new Date(NOW.getTime() + 2 * 86_400_000);
    expect(formatRelativeTime(target, NOW)).toBe("in 2d");
  });

  it("treats exactly the same instant as just now", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("just now");
  });
});

describe("formatUptime", () => {
  it.each([
    [0, "0s"],
    [59.9, "59s"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h 0m"],
    [86399, "23h 59m"],
    [90061, "1d 1h 1m"],
  ])("formats %s seconds as %s", (seconds, expected) => {
    expect(formatUptime(seconds)).toBe(expected);
  });
});
