import { describe, expect, it } from "vitest";
import { formatExpires, formatLastUsed, formatOptionalTimestamp, formatShortDate } from "./format";

describe("formatShortDate", () => {
  it("formats an ISO instant as YYYY-MM-DD", () => {
    expect(formatShortDate("2026-01-15T10:30:00.000Z")).toBe("2026-01-15");
  });
});

describe("formatOptionalTimestamp", () => {
  it("formats a present instant", () => {
    expect(formatOptionalTimestamp("2026-01-15T00:00:00.000Z", "Never")).toBe("2026-01-15");
  });

  it("returns the fallback for null", () => {
    expect(formatOptionalTimestamp(null, "Never")).toBe("Never");
  });
});

describe("formatLastUsed", () => {
  it("formats a present timestamp", () => {
    expect(formatLastUsed("2026-01-15T00:00:00.000Z")).toBe("2026-01-15");
  });

  it("shows 'Never' for null", () => {
    expect(formatLastUsed(null)).toBe("Never");
  });
});

describe("formatExpires", () => {
  it("formats a present timestamp", () => {
    expect(formatExpires("2026-06-01T00:00:00.000Z")).toBe("2026-06-01");
  });

  it("shows 'Never' for null", () => {
    expect(formatExpires(null)).toBe("Never");
  });
});
