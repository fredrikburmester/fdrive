import { describe, expect, it } from "vitest";
import { formatBytes, formatDate } from "./format.ts";

describe("formatBytes", () => {
  it("returns '0 B' for zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("returns '0 B' for negative values", () => {
    expect(formatBytes(-100)).toBe("0 B");
  });

  it("formats whole bytes below 1 KB without a decimal", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats bytes just below the KB boundary as B", () => {
    expect(formatBytes(1023)).toBe("1,023 B");
  });

  it("formats KB with one decimal", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats a whole number of KB with a trailing .0", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats MB with one decimal", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats GB with one decimal", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("formats TB with one decimal", () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024 * 1024)).toBe("3.0 TB");
  });

  it("caps at TB for extremely large values", () => {
    expect(formatBytes(2048 * 1024 * 1024 * 1024 * 1024)).toBe("2,048.0 TB");
  });

  it("applies the given locale", () => {
    expect(formatBytes(1536, { locale: "de-DE" })).toBe("1,5 KB");
  });
});

describe("formatDate", () => {
  const now = new Date(2024, 5, 15, 14, 30);

  it("formats a time earlier today as 'Today HH:MM'", () => {
    const date = new Date(2024, 5, 15, 9, 5);
    expect(formatDate(date, { now })).toBe("Today 09:05");
  });

  it("pads single-digit hours and minutes", () => {
    const date = new Date(2024, 5, 15, 1, 2);
    expect(formatDate(date, { now })).toBe("Today 01:02");
  });

  it("formats yesterday as 'Yesterday HH:MM'", () => {
    const date = new Date(2024, 5, 14, 9, 12);
    expect(formatDate(date, { now })).toBe("Yesterday 09:12");
  });

  it("formats a date earlier in the same year as a short date", () => {
    const date = new Date(2024, 0, 5, 8, 0);
    expect(formatDate(date, { now })).toBe("Jan 5");
  });

  it("formats a date in a different year with the year included", () => {
    const date = new Date(2022, 11, 25, 8, 0);
    expect(formatDate(date, { now })).toBe("Dec 25, 2022");
  });

  it("defaults now to the current time when not provided", () => {
    const result = formatDate(new Date());
    expect(result).toMatch(/^Today \d{2}:\d{2}$/);
  });

  it("applies the given locale to the short date format", () => {
    const date = new Date(2022, 11, 25, 8, 0);
    expect(formatDate(date, { now, locale: "en-GB" })).toBe("25 Dec 2022");
  });

  it("handles a year boundary correctly for yesterday", () => {
    const newYearsEve = new Date(2024, 0, 1, 10, 0);
    const date = new Date(2023, 11, 31, 23, 45);
    expect(formatDate(date, { now: newYearsEve })).toBe("Yesterday 23:45");
  });
});
